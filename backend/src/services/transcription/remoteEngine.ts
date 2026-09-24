import fs from 'node:fs/promises';
import path from 'node:path';

import {
  CancelledError,
  EngineUnavailableError,
  MUSICXML_FILENAME,
  MIDI_FILENAME,
  TranscriptionError,
} from './engine.js';
import type {
  EngineAvailability,
  EngineResult,
  ProgressReporter,
  TranscribeRequest,
  TranscriptionEngine,
} from './engine.js';
import { SHEET_TYPES } from './sheetTypes.js';
import type { SheetType } from './sheetTypes.js';

/**
 * REAL engine (remote): offloads heavy PyTorch inference to a separate
 * compute worker over HTTP so this server stays within a small memory
 * budget. Unlike the stub, every artifact here is produced by an actual
 * transcription run on the remote worker — this engine NEVER synthesizes
 * content. Both artifacts MUST arrive from the worker; anything missing or
 * malformed is an honest TranscriptionError, never a padded placeholder.
 *
 * Remote protocol (served by the compute worker, not this repo) is
 * ASYNC submit/poll — the POST never waits for inference, so a 2:30 track
 * that transcribes past Cloudflare's ~120 s request window cannot 524:
 *   POST /transcribe  multipart { audio, model, sheetType, instruments? }
 *     -> 202 application/json: { jobId: string, status: "processing" }
 *   GET  /jobs/{jobId}
 *     -> 200 { status: "processing" }                          (keep polling)
 *     -> 200 { status: "completed", result: {
 *                midiBase64: string, musicXml: string,
 *                metadata: { durationSec: number|null,
 *                            detectedInstruments: string[]|null,
 *                            tempoBpm?: number, keyName?: string } } }
 *          (the result payload is byte-identical in shape to the old
 *           synchronous API; it is validated by the same strict parser)
 *     -> 200 { status: "error", message: string }
 *     -> 404 { status: "not_found" }  (unknown id, consumed result, or the
 *          worker restarted and lost its in-memory registry)
 *
 * Selected via TRANSCRIPTION_ENGINE=remote + MUSCRIPTOR_REMOTE_URL.
 */
export class RemoteMuScriptorEngine implements TranscriptionEngine {
  readonly name = 'remote-muscriptor';
  readonly isMock = false;
  /** Layouts the remote worker genuinely renders (same vocabulary as local). */
  readonly supportedSheetTypes: readonly SheetType[] = SHEET_TYPES;

  /**
   * Upper bound on the JSON body accepted from the worker. Without it a
   * misbehaving worker could OOM this server with one response; 64 MB covers
   * long-track MusicXML with wide margin (segA-scale XML is ~100 KB).
   * Public so the shared bounded body reader below enforces the same limit.
   */
  static readonly MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

  /**
   * Budget for the SUBMIT request alone (upload + 202). The upload must
   * complete quickly by design — inference happens after the 202, so this
   * never needs to cover transcription time. Kept well under Cloudflare's
   * ~120 s request window.
   */
  private static readonly SUBMIT_TIMEOUT_MS = 90 * 1000;

  /**
   * Poll cadence for GET /jobs/{id}: frequent enough to settle promptly
   * after completion, sparse enough to cost the worker nothing (each poll is
   * a cheap in-memory registry read, never inference).
   */
  private static readonly POLL_INTERVAL_MS = 1500;

  constructor(
    private readonly remoteUrl: string,
    private readonly timeoutMs: number = 30 * 60 * 1000,
  ) {}

  /** Outbound identity: *.trycloudflare.com bot-mitigation blocks bare fetches. */
  private static readonly HEADERS: Record<string, string> = {
    'User-Agent': 'VigilanteBallThunder-Coordinator/1.0',
    Accept: 'application/json',
  };

  /**
   * Trimmed base URL with accidental trailing slashes stripped, so endpoint
   * paths never evaluate to `//health` or `//transcribe`.
   */
  private base(): string {
    return this.remoteUrl.trim().replace(/\/+$/, '');
  }

  async available(_forceRefresh = false): Promise<EngineAvailability> {
    const base = this.base();
    if (!base) {
      return {
        ok: false,
        code: 'remote-worker-unconfigured',
        reason:
          'TRANSCRIPTION_ENGINE=remote is set but MUSCRIPTOR_REMOTE_URL is empty. Configure the compute worker URL.',
      };
    }
    try {
      const res = await fetch(`${base}/health`, {
        headers: RemoteMuScriptorEngine.HEADERS,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          code: 'remote-worker-unhealthy',
          reason: `Remote worker at ${base} answered HTTP ${res.status}; not accepting jobs.`,
        };
      }
      return { ok: true };
    } catch {
      return {
        ok: false,
        code: 'remote-worker-offline',
        reason: `Compute worker at ${base} is unreachable. Transcription is unavailable until it comes back.`,
      };
    }
  }

  async transcribe(req: TranscribeRequest, onProgress: ProgressReporter): Promise<EngineResult> {
    const base = this.base();
    if (!base) {
      throw new EngineUnavailableError(
        'TRANSCRIPTION_ENGINE=remote is set but MUSCRIPTOR_REMOTE_URL is empty.',
        'remote-worker-unconfigured',
      );
    }
    if (req.signal.aborted) throw new CancelledError();
    await fs.mkdir(req.outDir, { recursive: true });

    onProgress('uploading_to_worker', 10);
    const fileBytes = await fs.readFile(req.audioPath);
    const formData = new FormData();
    formData.append('audio', new Blob([fileBytes]), path.basename(req.audioPath));
    formData.append('model', req.model);
    formData.append('sheetType', req.sheetType);
    // Same hard-constraint semantics as the local worker: only sent when set.
    if (req.instrumentGroups.length > 0) {
      formData.append('instruments', req.instrumentGroups.join(','));
    }

    onProgress('submitting_to_worker', 20);
    // SUBMIT: bounded by the short submit timeout, NOT the job timeout. The
    // worker answers 202 the moment the upload is staged; inference happens
    // afterwards, so a track that transcribes for 10 minutes never holds a
    // request open past Cloudflare's window. Cancellation wins over timeout.
    const submitTimeout = AbortSignal.timeout(RemoteMuScriptorEngine.SUBMIT_TIMEOUT_MS);
    const submitSignal = req.signal.aborted
      ? req.signal
      : AbortSignal.any([req.signal, submitTimeout]);
    let submitRes: Response;
    try {
      // NOTE: no explicit Content-Type — fetch sets the multipart boundary.
      submitRes = await fetch(`${base}/transcribe`, {
        method: 'POST',
        headers: RemoteMuScriptorEngine.HEADERS,
        body: formData,
        signal: submitSignal,
      });
    } catch (err: unknown) {
      if (req.signal.aborted) throw new CancelledError();
      throw new EngineUnavailableError(
        `Compute worker at ${base} could not be reached (${err instanceof Error ? err.message : 'fetch failed'}).`,
        'remote-worker-failed',
      );
    }
    if (req.signal.aborted) throw new CancelledError();
    if (!submitRes.ok) {
      const errText = (await submitRes.text().catch(() => '')).slice(0, 500);
      throw new TranscriptionError(
        `Remote worker refused the job with HTTP ${submitRes.status}${errText ? `: ${errText}` : ''}.`,
      );
    }
    const jobId = await readJobId(submitRes, base);

    onProgress('transcribing', 30);
    // POLL: the overall job budget is timeoutMs (default 30 min — comfortably
    // past any 2:30 track); each poll is a cheap registry read on the worker.
    // A poll that cannot complete means the worker is unreachable, which
    // surfaces as remote-worker-failed below — never as a fake result.
    const startedAt = Date.now();
    let polls = 0;
    for (;;) {
      if (req.signal.aborted) throw new CancelledError();
      if (Date.now() - startedAt > this.timeoutMs) {
        throw new TranscriptionError('Transcription timed out.');
      }
      await sleepAbortable(RemoteMuScriptorEngine.POLL_INTERVAL_MS, req.signal);
      if (req.signal.aborted) throw new CancelledError();
      let pollRes: Response;
      try {
        pollRes = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, {
          headers: RemoteMuScriptorEngine.HEADERS,
          signal: req.signal,
        });
      } catch (err: unknown) {
        if (req.signal.aborted) throw new CancelledError();
        throw new EngineUnavailableError(
          `Compute worker at ${base} could not be reached (${err instanceof Error ? err.message : 'fetch failed'}).`,
          'remote-worker-failed',
        );
      }
      if (req.signal.aborted) throw new CancelledError();
      if (pollRes.status === 404) {
        throw new TranscriptionError(
          'Remote worker lost track of the job (it may have restarted).',
        );
      }
      const raw = await readBoundedBody(pollRes);
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new TranscriptionError('Remote worker did not return valid JSON.');
      }
      const outcome = parseJobPoll(payload);
      if (outcome.status === 'processing') {
        polls += 1;
        // Honest progress: poll count only, never a fabricated percentage.
        onProgress('transcribing', Math.min(80, 30 + polls * 2));
        continue;
      }
      if (outcome.status === 'error') {
        throw new TranscriptionError(
          `Remote worker job failed${outcome.message ? `: ${outcome.message}` : '.'}`,
        );
      }
      // completed — the SAME payload shape the synchronous API returned,
      // validated by the SAME strict parser. Unknown extra fields ignored.
      onProgress('converting', 85);
      const parsed = parseRemotePayload(outcome.result);
      return finishTranscription(req, onProgress, parsed);
    }
  }
}

/** 202 submit payload: { jobId: string, status: "processing" }. */
async function readJobId(res: Response, base: string): Promise<string> {
  const raw = await readBoundedBody(res);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new TranscriptionError('Remote worker did not return valid JSON.');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new TranscriptionError('Remote worker returned an empty job registration.');
  }
  const jobId = (payload as Record<string, unknown>)['jobId'];
  if (typeof jobId !== 'string' || jobId.trim() === '') {
    throw new TranscriptionError(
      `Remote worker at ${base} did not return a job ID; cannot poll for the result.`,
    );
  }
  return jobId;
}

/** Poll payload: processing | completed+result | error+message. */
type JobPollOutcome =
  | { status: 'processing' }
  | { status: 'completed'; result: unknown }
  | { status: 'error'; message: string };

function parseJobPoll(payload: unknown): JobPollOutcome {
  if (typeof payload !== 'object' || payload === null) {
    throw new TranscriptionError('Remote worker returned an empty job status.');
  }
  const status = (payload as Record<string, unknown>)['status'];
  if (status === 'processing') return { status: 'processing' };
  if (status === 'completed') {
    return { status: 'completed', result: (payload as Record<string, unknown>)['result'] };
  }
  if (status === 'error') {
    const message = (payload as Record<string, unknown>)['message'];
    return { status: 'error', message: typeof message === 'string' ? message.slice(0, 500) : '' };
  }
  throw new TranscriptionError('Remote worker returned an unknown job status.');
}

/** Bounded body read shared by submit + poll (same 64 MB OOM guard). */
async function readBoundedBody(res: Response): Promise<string> {
  const raw = await res.text();
  if (raw.length > RemoteMuScriptorEngine.MAX_RESPONSE_BYTES) {
    throw new TranscriptionError(
      'Remote worker response exceeded the 64 MB limit; refusing to buffer it.',
    );
  }
  return raw;
}

/** setTimeout that settles early on abort (so DELETE cancels promptly). */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Validate-then-write completion: identical to the old synchronous path —
 * both artifacts validated BEFORE anything touches disk.
 */
async function finishTranscription(
  req: TranscribeRequest,
  onProgress: ProgressReporter,
  parsed: ValidRemotePayload,
): Promise<EngineResult> {
  // Both artifacts are validated BEFORE anything touches disk: a partial
  // write (MIDI without MusicXML) would leave a corrupt job behind.
  const midiPath = path.join(req.outDir, MIDI_FILENAME);
  const musicXmlPath = path.join(req.outDir, MUSICXML_FILENAME);
  await fs.writeFile(midiPath, parsed.midi);
  await fs.writeFile(musicXmlPath, parsed.musicXml, 'utf8');

  if (req.signal.aborted) throw new CancelledError();
  onProgress('done', 100);
  const result: EngineResult = {
    midiPath,
    musicXmlPath,
    durationSec: parsed.metadata.durationSec,
    model: req.model,
    engineUsed: `remote-muscriptor (${req.model})`,
    detectedInstruments: parsed.metadata.detectedInstruments,
  };
  // Genuinely-extracted metadata only: the field is present solely when
  // the worker actually supplied a value (same rule as the local worker).
  if (parsed.metadata.tempoBpm !== undefined || parsed.metadata.keyName !== undefined) {
    result.metadata = {};
    if (parsed.metadata.tempoBpm !== undefined) result.metadata.tempoBpm = parsed.metadata.tempoBpm;
    if (parsed.metadata.keyName !== undefined) result.metadata.keyName = parsed.metadata.keyName;
  }
  return result;
}

interface ValidRemotePayload {
  midi: Buffer;
  musicXml: string;
  metadata: {
    durationSec: number | null;
    detectedInstruments: string[] | null;
    tempoBpm?: number;
    keyName?: string;
  };
}

/**
 * Strict validation of the worker's JSON. Every field the EngineResult
 * contract exposes is checked here so nothing unvalidated reaches the job
 * record or the client's downloads. Unknown extra fields are ignored.
 */
function parseRemotePayload(payload: unknown): ValidRemotePayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new TranscriptionError('Remote worker returned an empty or invalid payload.');
  }
  const p = payload as Record<string, unknown>;

  if (typeof p['midiBase64'] !== 'string' || p['midiBase64'].length === 0) {
    throw new TranscriptionError('Remote worker returned no MIDI artifact.');
  }
  let midi: Buffer;
  try {
    midi = Buffer.from(p['midiBase64'], 'base64');
  } catch {
    throw new TranscriptionError('Remote worker returned undecodable MIDI data.');
  }
  if (midi.length === 0) {
    throw new TranscriptionError('Remote worker returned an empty MIDI artifact.');
  }

  // A real MusicXML document, not an empty shell: must be a score-partwise
  // document containing at least one part. (An earlier draft wrote a
  // hardcoded empty <score-partwise/> here; that would be fabricated output
  // and is rejected by this check instead.)
  if (
    typeof p['musicXml'] !== 'string' ||
    !p['musicXml'].includes('<score-partwise') ||
    !p['musicXml'].includes('<part')
  ) {
    throw new TranscriptionError('Remote worker returned no MusicXML artifact.');
  }

  if (typeof p['metadata'] !== 'object' || p['metadata'] === null) {
    throw new TranscriptionError('Remote worker returned no transcription metadata.');
  }
  const m = p['metadata'] as Record<string, unknown>;
  const durationSec =
    m['durationSec'] === null || m['durationSec'] === undefined ? null : m['durationSec'];
  if (durationSec !== null && (typeof durationSec !== 'number' || !Number.isFinite(durationSec))) {
    throw new TranscriptionError('Remote worker returned an invalid duration.');
  }
  const detectedRaw = m['detectedInstruments'];
  let detectedInstruments: string[] | null = null;
  if (detectedRaw !== null && detectedRaw !== undefined) {
    if (!Array.isArray(detectedRaw) || !detectedRaw.every((s): s is string => typeof s === 'string')) {
      throw new TranscriptionError('Remote worker returned invalid instrument data.');
    }
    detectedInstruments = [...detectedRaw];
  }
  // Genuinely-extracted values only: finite tempo, non-blank key. Anything
  // else is omitted, never defaulted — same rule as the local worker.
  let tempoBpm: number | undefined;
  if (typeof m['tempoBpm'] === 'number' && Number.isFinite(m['tempoBpm']) && m['tempoBpm'] > 0) {
    tempoBpm = m['tempoBpm'];
  }
  let keyName: string | undefined;
  if (typeof m['keyName'] === 'string' && m['keyName'].trim() !== '') {
    keyName = m['keyName'];
  }
  // exactOptionalPropertyTypes is on: only attach defined values.
  const metadata: {
    durationSec: number | null;
    detectedInstruments: string[] | null;
    tempoBpm?: number;
    keyName?: string;
  } = { durationSec, detectedInstruments };
  if (tempoBpm !== undefined) metadata.tempoBpm = tempoBpm;
  if (keyName !== undefined) metadata.keyName = keyName;
  return { midi, musicXml: p['musicXml'] as string, metadata };
}
