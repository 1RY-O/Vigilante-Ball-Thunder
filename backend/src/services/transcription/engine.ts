/**
 * Transcription engine boundary.
 *
 * Two concrete engines exist:
 *  - MuscriptorEngine (real): drives the Python MuScriptor worker.
 *  - StubEngine (MOCK, test/dev only): synthetic fixture output, always
 *    labeled as mock in code, logs, capabilities and the UI. It never claims
 *    to transcribe anything.
 */

export const MIDI_FILENAME = 'transcription.mid';
export const MUSICXML_FILENAME = 'transcription.musicxml';

export interface TranscribeRequest {
  audioPath: string;
  outDir: string;
  model: string;
  signal: AbortSignal;
}

export interface EngineResult {
  midiPath: string;
  musicXmlPath: string;
  durationSec: number | null;
  model: string;
}

/** Honest availability status surfaced verbatim in GET /api/capabilities. */
export interface EngineAvailability {
  ok: boolean;
  /** Machine-safe reason code, e.g. 'hf-token-missing'. */
  code?: string;
  /** Safe human message for the UI / API clients. */
  reason?: string;
}

export interface TranscriptionEngine {
  /** 'muscriptor' | 'stub' */
  readonly name: string;
  /** true ONLY for the mock/stub engine. Real engines are never mock. */
  readonly isMock: boolean;
  /** Check whether the engine can actually run jobs right now. */
  available(): Promise<EngineAvailability>;
  transcribe(req: TranscribeRequest, onProgress: ProgressReporter): Promise<EngineResult>;
}

export type ProgressReporter = (stage: string, percent?: number) => void;

/** Raised when a transcription fails for a reason safe to surface. */
export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

/** No notes could be produced from the audio (safe, honest outcome). */
export class EmptyTranscriptionError extends TranscriptionError {
  constructor(message = 'No notes could be detected in this recording.') {
    super(message);
    this.name = 'EmptyTranscriptionError';
  }
}

/**
 * Raised when the engine cannot even start for environmental reasons:
 * missing Python deps, missing HF token, gated weights, unreachable HF.
 * Maps to HTTP 503 so clients see an honest "service unavailable", never a
 * fabricated success.
 */
export class EngineUnavailableError extends Error {
  readonly code: string;
  constructor(message: string, code = 'engine-unavailable') {
    super(message);
    this.name = 'EngineUnavailableError';
    this.code = code;
  }
}

/** Raised when a running job was cancelled by the user. */
export class CancelledError extends Error {
  constructor() {
    super('Transcription was cancelled.');
    this.name = 'CancelledError';
  }
}
