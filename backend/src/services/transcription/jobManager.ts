import {
  CancelledError,
  EmptyTranscriptionError,
  EngineUnavailableError,
  TranscriptionError,
} from './engine.js';
import type { TranscriptionEngine } from './engine.js';
import type { Job, JobError, JobResult, PublicStatus } from '../../types/job.js';
import { newId } from '../../utils/id.js';
import { makeIsolatedDir, removeTree } from '../../utils/paths.js';

/**
 * Owns the job lifecycle: queued -> running -> complete | error.
 * (Public API maps running -> "transcribing".)
 *
 * - Bounded concurrency (model work is CPU/RAM heavy).
 * - DELETE /api/transcriptions/:id cancels safely: queued jobs are dequeued,
 *   running jobs have their worker subprocess killed; both settle as
 *   status "error" with code "cancelled" so the terminal state stays
 *   inspectable until the TTL sweeper removes it.
 * - No fabricated progress: only engine-reported percentages are forwarded.
 */
export class JobManager {
  private readonly engine: TranscriptionEngine;
  private readonly uploadDir: string;
  private readonly maxConcurrency: number;
  private readonly ttlMs: number;
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private active = 0;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(opts: {
    engine: TranscriptionEngine;
    uploadDir: string;
    maxConcurrency: number;
    ttlSec: number;
  }) {
    this.engine = opts.engine;
    this.uploadDir = opts.uploadDir;
    this.maxConcurrency = Math.max(1, opts.maxConcurrency);
    this.ttlMs = Math.max(50, opts.ttlSec * 1000);
  }

  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.expireOld(), Math.min(this.ttlMs, 60_000));
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  async createJob(model: string, uploadPath: string): Promise<Job> {
    const workDir = await makeIsolatedDir(this.uploadDir);
    const job: Job = {
      id: newId(),
      status: 'queued',
      model,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      progress: { stage: 'queued' },
      result: null,
      error: null,
      uploadPath,
      workDir,
      midiPath: null,
      musicXmlPath: null,
      abort: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /**
   * Cancel a job safely. Returns 'cancelled', 'already-terminal' or
   * 'not-found'. Cancelled jobs settle as error{cancelled}} and are cleaned
   * up (files removed) immediately; the record stays in memory until TTL so
   * clients can observe the terminal state.
   */
  async cancel(id: string): Promise<'cancelled' | 'already-terminal' | 'not-found'> {
    const job = this.jobs.get(id);
    if (!job) return 'not-found';
    if (job.status === 'complete' || job.status === 'error') return 'already-terminal';
    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);
    job.abort.abort(); // kills the worker subprocess if running
    if (job.status === 'queued') {
      // Never started: settle it here (running jobs settle in run()'s catch).
      await this.settleCancelled(job);
    }
    return 'cancelled';
  }

  /** Expire terminal jobs past TTL; remove their artifacts. */
  async expireOld(): Promise<void> {
    const now = Date.now();
    for (const job of [...this.jobs.values()]) {
      if (job.status !== 'complete' && job.status !== 'error') continue;
      const ref = job.finishedAt ?? job.createdAt;
      if (now - ref > this.ttlMs) {
        this.jobs.delete(job.id);
        await removeTree(job.workDir);
      }
    }
  }

  private async settleCancelled(job: Job): Promise<void> {
    job.status = 'error';
    job.error = { code: 'cancelled', message: 'Transcription was cancelled.' };
    job.finishedAt = Date.now();
    await removeTree(job.uploadPath);
    await removeTree(job.workDir);
  }

  private pump(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) continue;
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    if (job.abort.signal.aborted) {
      await this.settleCancelled(job);
      return;
    }
    job.status = 'running';
    job.startedAt = Date.now();
    try {
      const result = await this.engine.transcribe(
        {
          audioPath: job.uploadPath,
          outDir: job.workDir,
          model: job.model,
          signal: job.abort.signal,
        },
        (stage, percent) => {
          if (typeof percent === 'number') {
            job.progress = { stage, percent };
          } else {
            job.progress = { stage };
          }
        },
      );
      const resultUrls: JobResult = {
        musicxmlUrl: `/api/artifacts/${encodeURIComponent(job.id)}/musicxml`,
        midiUrl: `/api/artifacts/${encodeURIComponent(job.id)}/midi`,
      };
      job.result = resultUrls;
      job.midiPath = result.midiPath;
      job.musicXmlPath = result.musicXmlPath;
      job.status = 'complete';
      job.progress = { stage: 'done', percent: 100 };
      job.finishedAt = Date.now();
      await removeTree(job.uploadPath); // original audio no longer needed
    } catch (e) {
      await removeTree(job.uploadPath);
      if (e instanceof CancelledError || job.abort.signal.aborted) {
        await this.settleCancelled(job);
        return;
      }
      await removeTree(job.workDir);
      job.status = 'error';
      job.finishedAt = Date.now();
      job.error = toJobError(e);
    }
  }
}

function toJobError(e: unknown): JobError {
  if (e instanceof EmptyTranscriptionError) {
    return { code: 'empty-transcription', message: e.message };
  }
  if (e instanceof EngineUnavailableError) {
    return {
      code: 'engine-unavailable',
      message: 'The transcription engine became unavailable. ' + safeMessage(e.message),
      // e.code is a curated worker code (e.g. 'hf-token-missing'), safe to expose.
      cause: e.code,
    };
  }
  if (e instanceof TranscriptionError) {
    return { code: 'transcription-failed', message: safeMessage(e.message) };
  }
  return { code: 'transcription-failed', message: 'Transcription failed.' };
}

/** Strip anything that looks like a filesystem path from client messages. */
function safeMessage(message: string): string {
  return message.replace(/(\/[^\s:]+)+/g, '[path]').slice(0, 300);
}

const INTERNAL_TO_PUBLIC: Record<Job['status'], PublicStatus> = {
  queued: 'queued',
  running: 'transcribing',
  complete: 'complete',
  error: 'error',
};

export interface PublicJob {
  id: string;
  status: PublicStatus;
  progress?: number;
  result?: JobResult;
  error?: JobError;
}

/** Public wire view: no internal paths, no fabricated fields. */
export function toPublicJob(job: Job): PublicJob {
  const pub: PublicJob = { id: job.id, status: INTERNAL_TO_PUBLIC[job.status] };
  const pct = job.progress.percent;
  if (typeof pct === 'number' && Number.isFinite(pct)) {
    pub.progress = Math.min(100, Math.max(0, Math.round(pct)));
  }
  if (job.status === 'complete' && job.result) pub.result = job.result;
  if (job.status === 'error' && job.error) pub.error = job.error;
  return pub;
}
