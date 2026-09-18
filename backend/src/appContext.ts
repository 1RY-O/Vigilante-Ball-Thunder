import fs from 'node:fs/promises';
import type multer from 'multer';
import type { RequestHandler } from 'express';

import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { JobManager } from './services/transcription/jobManager.js';
import type { TranscriptionEngine } from './services/transcription/engine.js';
import { MuScriptorEngine } from './services/transcription/muScriptorEngine.js';
import { StubEngine } from './services/transcription/stubEngine.js';
import { buildRateLimiter } from './middleware/rateLimit.js';
import { buildUploadMiddleware } from './middleware/upload.js';

export interface AppContext {
  config: Config;
  engine: TranscriptionEngine;
  jobManager: JobManager;
  uploadMiddleware: multer.Multer;
  rateLimiter: RequestHandler;
  dispose: () => Promise<void>;
}

export interface ContextOverrides {
  config?: Partial<Config>;
  engine?: TranscriptionEngine;
  jobManager?: JobManager;
}

/**
 * Composition root. Tests inject overrides (mock engines, temp dirs,
 * raised rate limits) without touching global env.
 */
export async function buildContext(overrides: ContextOverrides = {}): Promise<AppContext> {
  const config: Config = { ...loadConfig(), ...overrides.config };
  await fs.mkdir(config.uploadDir, { recursive: true });

  const engine =
    overrides.engine ??
    (config.engine === 'stub'
      ? new StubEngine() // MOCK — labeled everywhere; see stubEngine.ts
      : new MuScriptorEngine({
          pythonBin: config.pythonBin,
          workerPath: config.workerPath,
          model: config.model,
          timeoutMs: config.workerTimeoutMs,
        }));

  const jobManager =
    overrides.jobManager ??
    new JobManager({
      engine,
      uploadDir: config.uploadDir,
      maxConcurrency: config.maxConcurrency,
      ttlSec: config.ttlSec,
    });
  jobManager.start();

  const uploadMiddleware = buildUploadMiddleware(config.uploadDir, config.maxUploadBytes);
  const rateLimiter = buildRateLimiter(config);

  return {
    config,
    engine,
    jobManager,
    uploadMiddleware,
    rateLimiter,
    dispose: async () => {
      jobManager.stop();
    },
  };
}
