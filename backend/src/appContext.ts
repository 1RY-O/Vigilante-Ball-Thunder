import fs from 'node:fs/promises';
import type multer from 'multer';
import type { RequestHandler } from 'express';

import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { JobManager } from './services/transcription/jobManager.js';
import { AvailabilityMonitor } from './services/transcription/availabilityMonitor.js';
import type { TranscriptionEngine } from './services/transcription/engine.js';
import { MuScriptorEngine } from './services/transcription/muScriptorEngine.js';
import { StubEngine } from './services/transcription/stubEngine.js';
import { PlaybackService } from './services/playback/playbackService.js';
import { buildRateLimiter } from './middleware/rateLimit.js';
import { buildUploadMiddleware } from './middleware/upload.js';

export interface AppContext {
  config: Config;
  engine: TranscriptionEngine;
  /**
   * Last known engine readiness + background warm-up. HTTP handlers read
   * `snapshot()` (never blocks); `index.ts` calls `start()` after listen.
   */
  availability: AvailabilityMonitor;
  jobManager: JobManager;
  /** FluidSynth-backed MIDI → WAV rendering (honest 503 when unavailable). */
  playback: PlaybackService;
  uploadMiddleware: multer.Multer;
  rateLimiter: RequestHandler;
  dispose: () => Promise<void>;
}

export interface ContextOverrides {
  config?: Partial<Config>;
  engine?: TranscriptionEngine;
  jobManager?: JobManager;
  playback?: PlaybackService;
}

/**
 * Composition root. Tests inject overrides (mock engines, temp dirs,
 * raised rate limits) without touching global env.
 */
export async function buildContext(overrides: ContextOverrides = {}): Promise<AppContext> {
  const config: Config = { ...loadConfig(), ...overrides.config };
  await fs.mkdir(config.uploadDir, { recursive: true });

  const engine: TranscriptionEngine =
    overrides.engine ??
    (config.engine === 'stub'
      ? new StubEngine() // MOCK — labeled everywhere; see stubEngine.ts
      : new MuScriptorEngine({
          pythonBin: config.pythonBin,
          workerPath: config.workerPath,
          model: config.model,
          timeoutMs: config.workerTimeoutMs,
          selfCheckTimeoutMs: config.selfCheckTimeoutMs,
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

  // Warm-up/poller is created but not started here: index.ts starts it right
  // after the server begins listening so every request can answer instantly
  // from the last-known snapshot.
  const availability = new AvailabilityMonitor(engine, config.warmupIntervalMs);

  const uploadMiddleware = buildUploadMiddleware(config.uploadDir, config.maxUploadBytes);
  const rateLimiter = buildRateLimiter(config);

  const playback =
    overrides.playback ??
    new PlaybackService({
      fluidsynthBin: config.fluidsynthBin,
      soundfontPath: config.soundfontPath,
      timeoutMs: config.playbackTimeoutMs,
      maxConcurrentRenders: config.maxPlaybackConcurrency,
    });

  return {
    config,
    engine,
    availability,
    jobManager,
    playback,
    uploadMiddleware,
    rateLimiter,
    dispose: async () => {
      availability.stop();
      engine.dispose?.(); // kill an in-flight warm-up probe — no orphans
      jobManager.stop();
    },
  };
}
