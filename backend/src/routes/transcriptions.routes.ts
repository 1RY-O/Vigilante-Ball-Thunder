import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';

import { isSupportedModel } from '../config.js';
import { EngineUnavailableError, ENGINE_WARMING_UP, ENGINE_WARMING_UP_CODE, TranscriptionError } from '../services/transcription/engine.js';
import { validateStagedUpload, ValidationError, wavDurationFromHeader, SUPPORTED_FORMATS } from '../services/audio/validation.js';
import { toPublicJob } from '../services/transcription/jobManager.js';
import { removeTree } from '../utils/paths.js';
import type { AppContext } from '../appContext.js';

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
        const job = await ctx.jobManager.createJob(requested || cfg.model, file.path);
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
  router.get('/capabilities', (_req, res) => {
    const { value, checking } = ctx.availability.snapshot();
    const availability = value ?? ENGINE_WARMING_UP;
    res.json({
      formats: [...SUPPORTED_FORMATS],
      maxUploadBytes: ctx.config.maxUploadBytes,
      maxAudioDurationSec: ctx.config.maxAudioDurationSec,
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
  });

  // GET /api/health — liveness only (not part of the frontend contract).
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', engine: ctx.engine.name, mock: ctx.engine.isMock });
  });

  return router;
}

/** Errors raised inside routes that need precise HTTP semantics. */
export { ValidationError, EngineUnavailableError, TranscriptionError };
