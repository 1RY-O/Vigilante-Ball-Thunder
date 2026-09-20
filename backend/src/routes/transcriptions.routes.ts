import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'node:path';

import { isSupportedModel } from '../config.js';
import {
  EngineUnavailableError,
  ENGINE_WARMING_UP,
  ENGINE_WARMING_UP_CODE,
  NotImplementedError,
  TranscriptionError,
} from '../services/transcription/engine.js';
import { DEFAULT_INSTRUMENT_HINT, INSTRUMENT_HINTS, instrumentGroupsForHint, isInstrumentHint } from '../services/transcription/instrumentHints.js';
import type { InstrumentHint } from '../services/transcription/instrumentHints.js';
import { DEFAULT_SHEET_TYPE, SHEET_TYPES, isSheetType } from '../services/transcription/sheetTypes.js';
import type { SheetType } from '../services/transcription/sheetTypes.js';
import { PlaybackFailedError, PlaybackUnavailableError } from '../services/playback/playbackService.js';
import { validateStagedUpload, ValidationError, wavDurationFromHeader, SUPPORTED_FORMATS } from '../services/audio/validation.js';
import { toPublicJob } from '../services/transcription/jobManager.js';
import { removeTree } from '../utils/paths.js';
import type { AppContext } from '../appContext.js';

const SHEET_TYPE_UNSUPPORTED_CODE = 'sheet-type-unsupported';

const asyncH = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export function buildTranscriptionsRouter(ctx: AppContext): Router {
  const router = Router();
  const cfg = ctx.config;

  // POST /api/transcriptions — stage upload, validate, queue a job.
  router.post(
    '/',
    ctx.rateLimiter,
    ctx.uploadMiddleware.single('file'),
    asyncH(async (req, res) => {
      const file = req.file;
      if (!file) throw new ValidationError('No audio file was uploaded (expected multipart field "file").', 400);
      try {
        const meta = await validateStagedUpload(
          file.path,
          file.mimetype,
          file.originalname || 'audio',
          cfg.maxUploadBytes,
        );
        // Duration check where cheaply decidable (WAV header is exact).
        if (meta.format === 'wav') {
          const duration = await wavDurationFromHeader(file.path);
          if (duration !== null && duration > cfg.maxAudioDurationSec) {
            throw new ValidationError(`Audio is too long (max ${cfg.maxAudioDurationSec} seconds).`, 415);
          }
        }
        const requested = String((req.body as Record<string, unknown> | undefined)?.['model'] ?? '').trim().toLowerCase();
        if (requested && !isSupportedModel(requested)) {
          throw new ValidationError('Unsupported model variant. Use small, medium or large.', 400);
        }
        // Optional instrument hint. Validated strictly: an unknown value is a
        // client error, never silently ignored (it would change the result).
        const rawInstrument = String((req.body as Record<string, unknown> | undefined)?.['instrument'] ?? '').trim().toLowerCase();
        let instrumentHint: InstrumentHint = DEFAULT_INSTRUMENT_HINT;
        if (rawInstrument) {
          if (!isInstrumentHint(rawInstrument)) {
            throw new ValidationError(
              `Unsupported instrument hint "${rawInstrument}". Use one of: ${INSTRUMENT_HINTS.join(', ')}.`,
              400,
            );
          }
          instrumentHint = rawInstrument;
        }
        // Optional free-text detail, sent by the client only with
        // instrument=other. There is no consumer for it yet (other sends no
        // group constraint by design), so it is accepted and ignored — never
        // an error, never acted upon.
        void (req.body as Record<string, unknown> | undefined)?.['instrumentDetail'];
        // Optional sheet type. A layout this engine cannot genuinely produce is
        // refused with 501 up front — never quietly answered with a different
        // layout (the check is a capability fact, independent of availability).
        const rawSheetType = String((req.body as Record<string, unknown> | undefined)?.['sheetType'] ?? '').trim().toLowerCase();
        let sheetType: SheetType = DEFAULT_SHEET_TYPE;
        if (rawSheetType) {
          if (!isSheetType(rawSheetType)) {
            throw new ValidationError(
              `Unsupported sheet type "${rawSheetType}". Use one of: ${SHEET_TYPES.join(', ')}.`,
              400,
            );
          }
          sheetType = rawSheetType;
        }
        if (!ctx.engine.supportedSheetTypes.includes(sheetType)) {
          throw new NotImplementedError(
            `The "${sheetType}" sheet layout is not implemented by the ${ctx.engine.name} engine on this deployment. ` +
              `Available layouts: ${ctx.engine.supportedSheetTypes.join(', ')}.`,
            SHEET_TYPE_UNSUPPORTED_CODE,
          );
        }
        // Honest gate: if the real engine cannot run (missing deps/token),
        // fail here with 503 — never queue a job that would fake success.
        // The gate reads the LAST KNOWN state (never blocks); while it is
        // still unknown (cold start) or known-bad it 503s honestly and pokes
        // the background warm-up, so the next request sees a fresher answer.
        const availability = ctx.availability.snapshot().value;
        if (!availability) {
          void ctx.availability.refresh();
          throw new EngineUnavailableError(ENGINE_WARMING_UP.reason ?? 'The engine is warming up.', ENGINE_WARMING_UP_CODE);
        }
        if (!availability.ok) {
          void ctx.availability.refresh();
          throw new EngineUnavailableError(
            availability.reason ?? 'The transcription engine is currently unavailable.',
            availability.code ?? 'engine-unavailable',
          );
        }
        const job = await ctx.jobManager.createJob({
          model: requested || cfg.model,
          sheetType,
          instrumentHint,
          uploadPath: file.path,
        });
        // Snapshot of the state the job was accepted in: honestly "queued"
        // even if the queue drains before the response is serialized.
        res.status(202).json({ id: job.id, status: 'queued' });
      } catch (e) {
        await removeTree(file.path); // validation failed: discard the upload
        throw e;
      }
    }),
  );

  // GET /api/transcriptions/:id — status, progress, result or safe error.
  router.get('/:id', (req, res) => {
    const job = ctx.jobManager.getJob(String(req.params.id ?? ''));
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    res.json(toPublicJob(job));
  });

  // DELETE /api/transcriptions/:id — safe cancellation. Queued jobs are
  // dequeued; running jobs have their worker killed; the job settles as
  // error{cancelled} and its files are removed. Idempotent on terminal jobs.
  router.delete(
    '/:id',
    asyncH(async (req, res) => {
      const outcome = await ctx.jobManager.cancel(String(req.params.id ?? ''));
      if (outcome === 'not-found') {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }
      const job = ctx.jobManager.getJob(String(req.params.id ?? ''));
      res.status(200).json(job ? toPublicJob(job) : { id: String(req.params.id ?? ''), status: 'error' });
    }),
  );

  return router;
}

export function buildArtifactsRouter(ctx: AppContext): Router {
  const router = Router();

  const sendArtifact = (kind: 'musicxml' | 'midi') =>
    (req: Request, res: Response) => {
      const job = ctx.jobManager.getJob(String(req.params.id ?? ''));
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }
      const filePath = kind === 'midi' ? job.midiPath : job.musicXmlPath;
      if (job.status !== 'complete' || !filePath) {
        res.status(409).json({ error: 'Artifact is not available yet.' });
        return;
      }
      res.sendFile(filePath, {
        headers: {
          'Content-Type': kind === 'midi' ? 'audio/midi' : 'application/vnd.recordare.musicxml+xml',
          'Content-Disposition': `attachment; filename="${kind === 'midi' ? 'transcription.mid' : 'transcription.musicxml'}"`,
          'Cache-Control': 'no-store',
        },
      });
    };

  router.get('/:id/musicxml', sendArtifact('musicxml'));
  router.get('/:id/midi', sendArtifact('midi'));

  /**
   * POST /api/artifacts/:id/playback — render the job's OWN transcription MIDI
   * to WAV with FluidSynth.
   *
   * - 404 unknown job, 409 job has no completed transcription.
   * - 503 `fluidsynth-missing` / `soundfont-missing` when the OS dependency or
   *   SoundFont is genuinely absent — never fake audio, never silence.
   * - 500 `playback-failed` if FluidSynth ran but produced no readable audio.
   * - Idempotent: re-requesting returns the already-rendered audio instead of
   *   rendering (and paying for) it again.
   */
  router.post(
    '/:id/playback',
    // Process-spawning endpoint: same per-IP budget as transcription, so an
    // unauthenticated client cannot hammer renders without limit.
    ctx.rateLimiter,
    asyncH(async (req, res) => {
      const job = ctx.jobManager.getJob(String(req.params.id ?? ''));
      if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
      }
      if (job.status !== 'complete' || !job.midiPath) {
        res.status(409).json({ error: 'Playback is only available once the transcription is complete.' });
        return;
      }
      const audioUrl = `/api/artifacts/${encodeURIComponent(job.id)}/audio`;
      // Already rendered in this process: report the existing artifact.
      if (job.audioPath) {
        const existing = await wavDurationFromHeader(job.audioPath);
        if (existing !== null && existing > 0) {
          res.status(200).json({ audioUrl, durationSec: existing });
          return;
        }
      }
      // Heavy, billable operation: re-check the dependency right now instead of
      // trusting a cached probe, so a soundfont added/removed since the last
      // capabilities poll is reflected honestly.
      const availability = await ctx.playback.probe(true);
      if (!availability.available) {
        throw new PlaybackUnavailableError(
          availability.reason ?? 'Audio playback is unavailable on this deployment.',
          availability.code ?? 'fluidsynth-missing',
        );
      }
      const wavPath = path.join(job.workDir, 'playback.wav');
      // Bounded + deduped: concurrent identical requests share one FluidSynth
      // run, and global concurrency stays <= MAX_PLAYBACK_CONCURRENCY.
      const durationSec = await ctx.playback.renderBounded(job.midiPath, wavPath);
      ctx.jobManager.recordPlayback(job.id, wavPath);
      res.status(200).json({ audioUrl, durationSec });
    }),
  );

  /** GET /api/artifacts/:id/audio — the rendered playback WAV. */
  router.get('/:id/audio', (req: Request, res: Response) => {
    const job = ctx.jobManager.getJob(String(req.params.id ?? ''));
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    if (!job.audioPath) {
      res.status(409).json({ error: 'Playback has not been generated for this job yet.' });
      return;
    }
    res.sendFile(job.audioPath, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Disposition': `inline; filename="${job.id}.wav"`,
        // Playback audio belongs to the requesting user only.
        'Cache-Control': 'private',
      },
    });
  });

  return router;
}

export function buildCapabilitiesRouter(ctx: AppContext): Router {
  const router = Router();

  // GET /api/capabilities — truthful view of what this deployment can do,
  // including whether the engine is real or the labeled mock, and whether
  // MuScriptor is actually ready (deps + HF access).
  //
  // This handler NEVER blocks: it answers from the last-known state and lets
  // the background warm-up/poller update it. `engine.available` is only ever
  // derived from a completed real probe; `engine.checking` says a fresh probe
  // is in flight (so a false value during warm-up is not a verdict).
  router.get('/capabilities', asyncH(async (_req, res) => {
    const { value, checking } = ctx.availability.snapshot();
    const availability = value ?? ENGINE_WARMING_UP;
    // The playback probe is a cheap local check (executable + soundfont file),
    // so it may be awaited inline: it never imports torch or touches the network.
    const playback = await ctx.playback.probe();
    res.json({
      formats: [...SUPPORTED_FORMATS],
      maxUploadBytes: ctx.config.maxUploadBytes,
      maxAudioDurationSec: ctx.config.maxAudioDurationSec,
      sheetTypes: {
        default: DEFAULT_SHEET_TYPE,
        supported: [...ctx.engine.supportedSheetTypes],
      },
      instrumentHints: {
        values: [...INSTRUMENT_HINTS],
        // Only hints that actually constrain the decode are listed as mapped;
        // auto/multi/other deliberately send no constraint (see instrumentHints.ts).
        mapped: Object.fromEntries(
          INSTRUMENT_HINTS.filter((h) => instrumentGroupsForHint(h).length > 0).map((h) => [h, [...instrumentGroupsForHint(h)]]),
        ),
      },
      playback: {
        available: playback.available,
        ...(playback.code ? { code: playback.code } : {}),
        ...(playback.reason ? { reason: playback.reason } : {}),
      },
      engine: {
        name: ctx.engine.name,
        mock: ctx.engine.isMock,
        available: availability.ok,
        checking,
        ...(availability.reason ? { reason: availability.reason } : {}),
        ...(availability.code ? { code: availability.code } : {}),
        model: ctx.config.model,
      },
    });
  }));

  // GET /api/health — liveness only (not part of the frontend contract).
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', engine: ctx.engine.name, mock: ctx.engine.isMock });
  });

  return router;
}

/** Errors raised inside routes that need precise HTTP semantics. */
export { ValidationError, EngineUnavailableError, TranscriptionError };
