import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  EmptyTranscriptionError,
  EngineUnavailableError,
  MIDI_FILENAME,
  MUSICXML_FILENAME,
  TranscriptionError,
  CancelledError,
} from './engine.js';
import type {
  EngineAvailability,
  EngineResult,
  ProgressReporter,
  TranscribeRequest,
  TranscriptionEngine,
} from './engine.js';

/**
 * REAL engine: drives backend/python/transcribe_worker.py as a subprocess.
 *
 * Honesty contract:
 *  - available() runs the worker's --self-check, which verifies the python
 *    deps AND the Hugging Face token / gated-license access. When anything is
 *    missing, availability is { ok: false, reason } and POST /api/transcriptions
 *    answers 503 — never a fake job, never a fake result.
 *  - Progress percentages come only from real worker progress lines.
 *  - HF_TOKEN (and every secret) is passed through the environment only; it
 *    is never logged or sent to clients.
 */
export class MuScriptorEngine implements TranscriptionEngine {
  readonly name = 'muscriptor';
  readonly isMock = false;

  private readonly pythonBin: string;
  private readonly workerPath: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private cachedAvailability: { at: number; value: EngineAvailability } | null = null;

  constructor(opts: {
    pythonBin: string;
    workerPath: string;
    model: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    selfCheckTimeoutMs?: number;
  }) {
    this.pythonBin = opts.pythonBin;
    this.workerPath = opts.workerPath;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
    this.baseEnv = opts.env ? { ...opts.env } : { ...process.env };
    if (typeof opts.selfCheckTimeoutMs === 'number' && Number.isFinite(opts.selfCheckTimeoutMs)) {
      this.selfCheckTimeoutMs = Math.max(1000, Math.floor(opts.selfCheckTimeoutMs));
    }
  }

  /**
   * Timeout after which a hung self-check is killed → honest unavailable.
   * A CPU-only cold start (torch import + gated-weight probe) takes 45-60s on
   * an 8GB laptop, so a 30s budget aborted checks that were merely slow.
   * Override with MUSCRIPTOR_SELFCHECK_TIMEOUT_MS.
   */
  private selfCheckTimeoutMs = 120_000;

  async available(forceRefresh = false): Promise<EngineAvailability> {
    const ttlMs = 60_000;
    if (!forceRefresh && this.cachedAvailability && Date.now() - this.cachedAvailability.at < ttlMs) {
      return this.cachedAvailability.value;
    }
    const value = await this.runSelfCheck();
    this.cachedAvailability = { at: Date.now(), value };
    return value;
  }

  /** Backend capabilities view: model id is safe to expose. */
  configuredModel(): string {
    return this.model;
  }

  async transcribe(req: TranscribeRequest, onProgress: ProgressReporter): Promise<EngineResult> {
    const availability = await this.available();
    if (!availability.ok) {
      throw new EngineUnavailableError(
        availability.reason ?? 'MuScriptor is not available.',
        availability.code ?? 'engine-unavailable',
      );
    }
    await fs.mkdir(req.outDir, { recursive: true });

    return new Promise<EngineResult>((resolve, reject) => {
      const args = [
        this.workerPath,
        '--audio', req.audioPath,
        '--out', req.outDir,
        '--model', req.model,
      ];
      const child = spawn(this.pythonBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.baseEnv,
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new TranscriptionError('Transcription timed out.'));
      }, this.timeoutMs);
      timer.unref();

      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
        clearTimeout(timer);
        reject(new CancelledError());
      };
      if (req.signal.aborted) {
        child.kill('SIGKILL');
        clearTimeout(timer);
        reject(new CancelledError());
        return;
      }
      req.signal.addEventListener('abort', onAbort, { once: true });

      let stderr = '';
      let failure: { code: string; message: string } | null = null;
      child.stdout.setEncoding('utf8');
      let stdoutBuf = '';
      child.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // non-JSON noise (warnings) is ignored
          }
          if (typeof msg !== 'object' || msg === null) continue;
          const m = msg as Record<string, unknown>;
          if (m['type'] === 'progress' && typeof m['stage'] === 'string') {
            const pct = typeof m['percent'] === 'number' && Number.isFinite(m['percent'])
              ? Math.min(100, Math.max(0, Math.round(m['percent'])))
              : undefined;
            onProgress(m['stage'], pct);
          } else if (m['type'] === 'error' && typeof m['code'] === 'string' && typeof m['message'] === 'string') {
            failure = { code: m['code'], message: m['message'] };
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
        reject(
          new EngineUnavailableError(
            err.code === 'ENOENT'
              ? 'Python runtime not found. Install backend/python/requirements.txt into backend/.venv or set PYTHON_BIN.'
              : 'Transcription worker could not start.',
            'python-not-found',
          ),
        );
      });
      child.on('close', async (code) => {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
        if (req.signal.aborted) {
          resolveCancelled(reject);
          return;
        }
        if (code !== 0 || failure) {
          const tail = stderr.trim().slice(-800);
          if (tail) console.error('[muscriptor-worker] stderr tail:', tail);
          reject(mapFailure(failure));
          return;
        }
        try {
          resolve(await this.readResult(req.outDir));
        } catch (e) {
          reject(e instanceof TranscriptionError ? e : new TranscriptionError('Transcription output was incomplete.'));
        }
      });
    });
  }

  private async readResult(outDir: string): Promise<EngineResult> {
    const midiPath = path.join(outDir, MIDI_FILENAME);
    const musicXmlPath = path.join(outDir, MUSICXML_FILENAME);
    const [midiOk, xmlOk] = await Promise.all([statOk(midiPath), statOk(musicXmlPath)]);
    if (!midiOk || !xmlOk) {
      throw new TranscriptionError('Transcription output was incomplete.');
    }
    let durationSec: number | null = null;
    let model = this.model;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(outDir, 'result.json'), 'utf8')) as Record<string, unknown>;
      if (typeof raw['durationSec'] === 'number' && Number.isFinite(raw['durationSec'])) durationSec = raw['durationSec'];
      if (typeof raw['model'] === 'string' && raw['model']) model = raw['model'];
    } catch {
      // result.json is informational; artifacts are what matters
    }
    return { midiPath, musicXmlPath, durationSec, model };
  }

  private runSelfCheck(): Promise<EngineAvailability> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: EngineAvailability): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const child = spawn(this.pythonBin, [this.workerPath, '--self-check', '--model', this.model], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.baseEnv,
      });
      // Hung self-checks (e.g. slow torch import on 8GB laptops) must not hang
      // capabilities/POST: kill and report honestly as unavailable.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({
          ok: false,
          code: 'engine-unavailable',
          reason: 'MuScriptor availability check timed out. The worker did not respond in time.',
        });
      }, this.selfCheckTimeoutMs);
      timer.unref();
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (stdout += c));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => (stderr += c));
      child.on('error', (err: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          code: 'python-not-found',
          reason:
            err.code === 'ENOENT'
              ? 'Python runtime not found. Install backend/python/requirements.txt into backend/.venv or set PYTHON_BIN.'
              : `MuScriptor worker could not start: ${err.message}`,
        });
      });
      child.on('close', (code) => {
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        const reason = lastErrorLine(stdout) ?? 'MuScriptor dependencies are not satisfied in the worker environment.';
        const codeName = lastErrorCode(stdout) ?? 'engine-unavailable';
        if (stderr.trim()) console.error('[muscriptor-worker] self-check stderr:', stderr.trim().slice(-400));
        finish({ ok: false, code: codeName, reason });
      });
    });
  }
}

function resolveCancelled(reject: (e: Error) => void): void {
  reject(new CancelledError());
}

function lastErrorLine(stdout: string): string | null {
  for (const line of stdout.trim().split('\n').reverse()) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t) as Record<string, unknown>;
      if (m['type'] === 'error' && typeof m['message'] === 'string') {
        return m['code'] === 'hf-token-missing'
          ? 'HF_TOKEN is missing. Create backend/.env with HF_TOKEN and accept the MuScriptor model license on Hugging Face.'
          : m['message'];
      }
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

function lastErrorCode(stdout: string): string | null {
  for (const line of stdout.trim().split('\n').reverse()) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t) as Record<string, unknown>;
      if (m['type'] === 'error' && typeof m['code'] === 'string') return m['code'];
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/** Map worker failure codes to safe, honest errors. */
function mapFailure(failure: { code: string; message: string } | null): Error {
  if (!failure) return new TranscriptionError('Transcription failed.');
  switch (failure.code) {
    case 'hf-token-missing':
    case 'weights-gated':
    case 'hf-unreachable':
    case 'worker-deps-missing':
    case 'python-not-found':
    case 'worker-args-invalid':
      return new EngineUnavailableError(failure.message, failure.code);
    case 'empty-transcription':
      return new EmptyTranscriptionError(failure.message);
    default:
      return new TranscriptionError(failure.message);
  }
}

async function statOk(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}
