import { config as loadDotenv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HERE is backend/src under tsx/vitest and backend/dist after `npm run build`;
// in both cases backend/ is one level up.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.resolve(HERE, '..');

// Load backend/.env explicitly (never commit it; it may contain HF_TOKEN).
// Existing process env wins. HF_TOKEN is never logged by this codebase.
loadDotenv({ path: path.join(BACKEND_DIR, '.env') });

export type EngineKind = 'muscriptor' | 'stub';

export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  maxUploadBytes: number;
  maxAudioDurationSec: number;
  uploadDir: string;
  ttlSec: number;
  maxConcurrency: number;
  model: string;
  pythonBin: string;
  workerPath: string;
  engine: EngineKind;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  workerTimeoutMs: number;
  /**
   * Budget for one MuScriptor `--self-check` run (python deps +
   * gated-weight access). CPU-only cold start (torch import + ~400MB model
   * metadata) takes 45-60s on an 8GB laptop, so the default is generous.
   */
  selfCheckTimeoutMs: number;
  /** Only whether a token exists; the value is only forwarded to the worker. */
  hfTokenPresent: boolean;
}

export const SUPPORTED_MODELS = ['small', 'medium', 'large'] as const;
export function isSupportedModel(model: string): boolean {
  return (SUPPORTED_MODELS as readonly string[]).includes(model);
}

const int = (v: string | undefined, def: number): number => {
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

function defaultPythonBin(): string {
  const venvPython = path.join(BACKEND_DIR, '.venv', 'bin', 'python');
  return fs.existsSync(venvPython) ? venvPython : 'python3';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const model = env.MUSCRIPTOR_MODEL ?? 'small';
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: int(env.PORT, 4000),
    host: env.HOST ?? '127.0.0.1',
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 25 * 1024 * 1024),
    maxAudioDurationSec: int(env.MAX_AUDIO_DURATION_SEC, 600),
    uploadDir: env.UPLOAD_DIR ?? path.join(BACKEND_DIR, 'data', 'uploads'),
    ttlSec: int(env.JOB_TTL_SEC, 30 * 60),
    maxConcurrency: Math.max(1, int(env.MAX_CONCURRENCY, 1)), // CPU-bound model
    model: isSupportedModel(model) ? model : 'small',
    pythonBin: env.PYTHON_BIN ?? defaultPythonBin(),
    workerPath: env.WORKER_PATH ?? path.join(BACKEND_DIR, 'python', 'transcribe_worker.py'),
    engine: env.TRANSCRIPTION_ENGINE === 'stub' ? 'stub' : 'muscriptor',
    rateLimitWindowMs: int(env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
    rateLimitMax: int(env.RATE_LIMIT_MAX, 10),
    workerTimeoutMs: int(env.WORKER_TIMEOUT_MS, 30 * 60 * 1000),
    // Cold start (torch import + gated-weight probe) is 45-60s on CPU-only
    // 8GB machines; 30s used to abort a check that was merely slow.
    selfCheckTimeoutMs: int(env.MUSCRIPTOR_SELFCHECK_TIMEOUT_MS, 120_000),
    hfTokenPresent: !!env.HF_TOKEN && env.HF_TOKEN.trim() !== '',
  };
}
