/**
 * Internal job representation (server-only). The public wire shape is built
 * by `toPublicJob` in services/transcription/jobManager.ts.
 */

export type InternalStatus = 'queued' | 'running' | 'complete' | 'error';

export type PublicStatus = 'queued' | 'transcribing' | 'complete' | 'error';

/** Safe, curated error codes shown to clients. Never carries internals. */
export type JobErrorCode =
  | 'transcription-failed'
  | 'engine-unavailable'
  | 'empty-transcription'
  | 'cancelled';

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

export interface JobResult {
  musicxmlUrl: string;
  midiUrl: string;
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
  /** Aborts in-flight work (worker subprocess) for cancellation. */
  abort: AbortController;
}
