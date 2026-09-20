/**
 * Transcription engine boundary.
 *
 * Two concrete engines exist:
 *  - MuscriptorEngine (real): drives the Python MuScriptor worker.
 *  - StubEngine (MOCK, test/dev only): synthetic fixture output, always
 *    labeled as mock in code, logs, capabilities and the UI. It never claims
 *    to transcribe anything.
 */

import type { SheetType } from './sheetTypes.js';

export const MIDI_FILENAME = 'transcription.mid';
export const MUSICXML_FILENAME = 'transcription.musicxml';

export interface TranscribeRequest {
  audioPath: string;
  outDir: string;
  model: string;
  /** Notation layout to produce (the worker post-processes the MIDI). */
  sheetType: SheetType;
  /**
   * muscriptor instrument group names to allow (a HARD constraint), or an
   * empty array for "no hint" — see instrumentHints.ts.
   */
  instrumentGroups: readonly string[];
  signal: AbortSignal;
}

/** Analysis the engine genuinely extracted from the produced artifact. */
export interface EngineMetadata {
  tempoBpm?: number;
  keyName?: string;
}

export interface EngineResult {
  midiPath: string;
  musicXmlPath: string;
  durationSec: number | null;
  model: string;
  /**
   * Truthful provenance of this result, stated by the engine itself, e.g.
   * "muscriptor (small)" or the stub engine's MOCK label. Must never imply a
   * real transcription for the mock engine.
   */
  engineUsed: string;
  /**
   * Instruments the engine actually decoded (its own output), or null when it
   * cannot report them. Never inferred or guessed.
   */
  detectedInstruments: string[] | null;
  /** Present only when at least one field was genuinely extracted. */
  metadata?: EngineMetadata;
}

/**
 * Availability code emitted when the background `--self-check` did not finish
 * within its budget. On a CPU-only machine this means "still warming up"
 * (torch import + gated-weight probe), NOT "broken" — callers must branch on
 * this code rather than on message text.
 */
export const SELF_CHECK_TIMEOUT_CODE = 'self-check-timeout';

/**
 * Honest placeholder used while the first background probe is still running:
 * the engine is neither known-good nor known-broken. It is not a fabricated
 * success and not a real failure — the warm-up replaces it with a real result.
 */
export const ENGINE_WARMING_UP_CODE = 'engine-warming-up';

/** Honest availability status surfaced verbatim in GET /api/capabilities. */
export interface EngineAvailability {
  ok: boolean;
  /** Machine-safe reason code, e.g. 'hf-token-missing'. */
  code?: string;
  /** Safe human message for the UI / API clients. */
  reason?: string;
}

/** Reported by requests before the first completed probe (see monitor). */
export const ENGINE_WARMING_UP: EngineAvailability = {
  ok: false,
  code: ENGINE_WARMING_UP_CODE,
  reason:
    'MuScriptor is warming up after a cold start. The first availability check can take under a minute; the status updates automatically.',
};

export interface TranscriptionEngine {
  /** 'muscriptor' | 'stub' */
  readonly name: string;
  /** true ONLY for the mock/stub engine. Real engines are never mock. */
  readonly isMock: boolean;
  /**
   * Sheet layouts this engine can GENUINELY produce. Requests for anything
   * outside this list are refused with HTTP 501 (`sheet-type-unsupported`)
   * instead of being silently downgraded to another layout.
   */
  readonly supportedSheetTypes: readonly SheetType[];
  /**
   * Check whether the engine can actually run jobs right now.
   * `forceRefresh` bypasses the engine-internal cache (used by the background
   * availability monitor so a poll is always a real check). Callers that must
   * never block should read AvailabilityMonitor.snapshot() instead.
   */
  available(forceRefresh?: boolean): Promise<EngineAvailability>;
  transcribe(req: TranscribeRequest, onProgress: ProgressReporter): Promise<EngineResult>;
  /**
   * Optional: release engine-owned resources on shutdown (e.g. kill an
   * in-flight availability probe so nothing is left orphaned).
   */
  dispose?(): void;
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
 * Raised when a requested transformation cannot be produced — either because
 * the engine does not support it (pre-flight, e.g. the MOCK stub engine has no
 * music21) or because the worker genuinely failed to build it (e.g. music21
 * could not lay the decoded MIDI out as the requested sheet type). Maps to
 * HTTP 501 with a curated code; never silently downgraded to another layout
 * and never padded with invented content.
 */
export class NotImplementedError extends TranscriptionError {
  readonly code: string;
  constructor(message: string, code = 'not-implemented') {
    super(message);
    this.name = 'NotImplementedError';
    this.code = code;
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
