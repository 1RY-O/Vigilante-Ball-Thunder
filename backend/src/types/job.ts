/**
 * Internal job representation (server-only). The public wire shape is built
 * by `toPublicJob` in services/transcription/jobManager.ts.
 */

import type { InstrumentHint } from '../services/transcription/instrumentHints.js';
import type { SheetType } from '../services/transcription/sheetTypes.js';

export type InternalStatus = 'queued' | 'running' | 'complete' | 'error';

export type PublicStatus = 'queued' | 'transcribing' | 'complete' | 'error';

/** Safe, curated error codes shown to clients. Never carries internals. */
export type JobErrorCode =
  | 'transcription-failed'
  | 'engine-unavailable'
  | 'empty-transcription'
  | 'cancelled'
  | 'not-implemented';

export interface JobError {
  code: JobErrorCode;
  /** Safe, non-internal message. Stack traces / paths are never exposed. */
  message: string;
  /**
   * Optional safe machine-readable cause (worker failure code such as
   * 'hf-token-missing'). Never carries paths, tokens, or stderr text.
   */
  cause?: string;
}

/**
 * Audio analysis of the produced transcription, extracted by the engine from
 * the REAL artifact (music21 reading the decoded MIDI). Fields are present
 * only when they were genuinely extracted — a field music21 could not read is
 * omitted, never guessed.
 */
export interface JobMetadata {
  /** Tempo of the transcribed MIDI's metronome mark (BPM). */
  tempoBpm?: number;
  /** Key reported by music21's `analyze('key')`, e.g. "E minor". */
  keyName?: string;
}

export interface JobResult {
  musicxmlUrl: string;
  midiUrl: string;
  /** Present only once server-side playback has actually been rendered. */
  audioUrl?: string;
  /** Engine + model that produced this result (e.g. "muscriptor (small)"). */
  engineUsed: string;
  /** Audio duration reported by the engine, or null when it did not. */
  durationSec: number | null;
  /** Wall-clock ms from job start to completion (measured, never estimated). */
  transcriptionMs: number;
  /** Instruments the engine actually decoded, or null when it did not report any. */
  detectedInstruments: string[] | null;
  /** Tempo/key, when the engine genuinely extracted them. */
  metadata?: JobMetadata;
}

export interface JobProgress {
  /** Coarse honest stage label reported by the engine (never fabricated). */
  stage: string;
  /** Engine-reported percent 0-100, or undefined when unknown. */
  percent?: number;
}

export interface Job {
  id: string;
  status: InternalStatus;
  model: string;
  /** Notation layout requested at creation time (never re-negotiated). */
  sheetType: SheetType;
  /** Instrument hint requested at creation time (already validated). */
  instrumentHint: InstrumentHint;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: JobProgress;
  result: JobResult | null;
  error: JobError | null;
  /** Absolute path of the staged upload (deleted once processing starts). */
  uploadPath: string;
  /** Absolute path of the job work dir holding output artifacts. */
  workDir: string;
  midiPath: string | null;
  musicXmlPath: string | null;
  /** Rendered playback WAV, set only after a real FluidSynth render. */
  audioPath: string | null;
  /** Aborts in-flight work (worker subprocess) for cancellation. */
  abort: AbortController;
}
