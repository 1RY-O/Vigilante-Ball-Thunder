import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import request from 'supertest';

import { buildContext } from '../src/appContext.js';
import type { AppContext } from '../src/appContext.js';
import { createApp } from '../src/app.js';
import { StubEngine } from '../src/services/transcription/stubEngine.js';
import { MuScriptorEngine } from '../src/services/transcription/muScriptorEngine.js';
import type { Config } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_WORKER = path.resolve(HERE, 'fixtures', 'fake_worker.py');
export const REAL_WORKER = path.resolve(HERE, '..', 'python', 'transcribe_worker.py');

export interface TestApp {
  app: Express;
  agent: ReturnType<typeof request>;
  /** Full context — lets tests drive the availability monitor directly. */
  ctx: AppContext;
  tmpRoot: string;
  cleanup: () => Promise<void>;
}

/**
 * Build an isolated app instance against a temp upload dir.
 *
 * engine options:
 *  - 'stub'    — the shipped MOCK StubEngine (labeled, TRANSCRIPTION_ENGINE=stub path)
 *  - 'muscriptor-fake' — the REAL MuScriptorEngine class pointed at a
 *    protocol-faithful FAKE python worker (deterministic, offline). NOT a
 *    real model; test fixture only.
 */
export async function makeTestApp(opts: {
  engine: 'stub' | 'muscriptor-fake';
  workerMode?: string;
  config?: Partial<Config>;
  /**
   * Run the availability probe before returning (default true) so tests never
   * race the cold-start window. Set false to observe the warm-up behaviour.
   */
  prewarm?: boolean;
}): Promise<TestApp> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vbt-backend-test-'));
  const config: Partial<Config> = {
    uploadDir: path.join(tmpRoot, 'uploads'),
    rateLimitMax: 10_000,
    rateLimitWindowMs: 60_000,
    maxUploadBytes: 5 * 1024 * 1024,
    maxAudioDurationSec: 600,
    ttlSec: 3_600,
    maxConcurrency: 1,
    workerTimeoutMs: 15_000,
    model: 'small',
    ...opts.config,
  };
  const env = { ...process.env };
  delete env['HF_TOKEN'];
  if (opts.workerMode) env['FAKE_WORKER_MODE'] = opts.workerMode;

  const engine =
    opts.engine === 'stub'
      ? new StubEngine()
      : new MuScriptorEngine({
          pythonBin: 'python3',
          workerPath: FAKE_WORKER,
          model: config.model ?? 'small',
          timeoutMs: config.workerTimeoutMs ?? 15_000,
          selfCheckTimeoutMs: config.selfCheckTimeoutMs ?? 120_000,
          env,
        });

  const ctx = await buildContext({ config, engine });
  const app = createApp(ctx);
  // Deterministic starting state: run the SAME real probe the background
  // warm-up would run, so tests never race the cold-start window. The probe is
  // an honest engine check (stub = instant, fake worker = instant); nothing is
  // fabricated by seeding the monitor.
  if (opts.prewarm !== false) await ctx.availability.refresh();
  return {
    app,
    agent: request(app),
    ctx,
    tmpRoot,
    cleanup: async () => {
      await ctx.dispose();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Poll a job until it leaves queued/transcribing (or timeout). */
export async function waitForTerminal(
  agent: ReturnType<typeof request>,
  id: string,
  timeoutMs = 20_000,
): Promise<{ body: Record<string, unknown> }> {
  const started = Date.now();
  for (;;) {
    const res = await agent.get(`/api/transcriptions/${encodeURIComponent(id)}`);
    const status = (res.body as Record<string, unknown>)['status'];
    if (status === 'complete' || status === 'error') return res;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`job ${id} did not reach a terminal state (last: ${String(status)})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 16-bit PCM mono WAV buffer (8 kHz) with a pure 440 Hz tone. Real audio. */
export function makeWav(seconds = 0.25, sampleRate = 8000): Buffer {
  const frames = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const amp = Math.sin(2 * Math.PI * 440 * t) * 0.2;
    data.writeInt16LE(Math.round(amp * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Minimal MP3 sniff (ID3 header only — content need not decode for 415/OK tests). */
export function makeMp3Sniff(): Buffer {
  return Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x21', 'binary'), Buffer.alloc(64)]);
}

/** FLAC magic + empty body (sniff only). */
export function makeFlacSniff(): Buffer {
  return Buffer.from('fLaC\x00\x00\x00\x22', 'binary');
}
