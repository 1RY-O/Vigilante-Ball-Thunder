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
 * Remote protocol (served by the compute worker, not this repo):
 *   GET  /health      -> 200 when ready to accept jobs
 *   POST /transcribe  multipart { audio, model, sheetType, instruments? }
 *     -> 200 application/json:
 *        { midiBase64: string, musicXml: string,
 *          metadata: { durationSec: number|null,
 *                      detectedInstruments: string[]|null,
 *                      tempoBpm?: number, keyName?: string } }
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
   */
  private static readonly MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

  constructor(
    private readonly remoteUrl: string,
    private readonly timeoutMs: number = 30 * 60 * 1000,
  ) {}

  async available(_forceRefresh = false): Promise<EngineAvailability> {
    const base = this.remoteUrl.trim();
    if (!base) {
      return {
        ok: false,
        code: 'remote-worker-unconfigured',
        reason:
          'TRANSCRIPTION_ENGINE=remote is set but MUSCRIPTOR_REMOTE_URL is empty. Configure the compute worker URL.',
      };
    }
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
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
    const base = this.remoteUrl.trim();
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

    onProgress('transcribing', 30);
    // The job-level timeout races cancellation: whichever fires first wins,
    // and an abort is always reported as CancelledError, never as failure.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal.aborted ? req.signal : AbortSignal.any([req.signal, timeout]);
    let res: Response;
    try {
      res = await fetch(`${base}/transcribe`, { method: 'POST', body: formData, signal });
    } catch (err: unknown) {
      if (req.signal.aborted) throw new CancelledError();
      throw new EngineUnavailableError(
        `Compute worker at ${base} could not be reached (${err instanceof Error ? err.message : 'fetch failed'}).`,
        'remote-worker-failed',
      );
    }
    if (req.signal.aborted) throw new CancelledError();
    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, 500);
      // A remote 422/empty-transcription is a real outcome, but this engine
      // cannot distinguish it from a crash without a contract code; report
      // honestly as a remote failure with the worker's own message attached.
      throw new TranscriptionError(
        `Remote worker failed with HTTP ${res.status}${errText ? `: ${errText}` : ''}.`,
      );
    }

    onProgress('converting', 85);
    const raw = await res.text();
    if (raw.length > RemoteMuScriptorEngine.MAX_RESPONSE_BYTES) {
      throw new TranscriptionError(
        'Remote worker response exceeded the 64 MB limit; refusing to buffer it.',
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new TranscriptionError('Remote worker did not return valid JSON.');
    }
    const parsed = parseRemotePayload(payload);

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
