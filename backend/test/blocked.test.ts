import { afterAll, describe, expect, it } from 'vitest';

import { FAKE_WORKER, makeTestApp, makeWav, waitForTerminal } from './helpers.js';
import { MuScriptorEngine } from '../src/services/transcription/muScriptorEngine.js';
import { buildContext } from '../src/appContext.js';
import { createApp } from '../src/app.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

/**
 * HARD-RULE test: when MuScriptor cannot run (missing HF token, gated
 * weights, missing python), POST /api/transcriptions MUST fail with 503 —
 * never 202, never a fake job, never fabricated output.
 */

describe('blocked MuScriptor is honest (no fabrication)', () => {
  it('missing HF token -> POST 503 with safe reason, capabilities report unavailability', async () => {
    const t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'no-token' });
    try {
      const caps = await t.agent.get('/api/capabilities');
      expect(caps.status).toBe(200);
      expect(caps.body.engine.available).toBe(false);
      expect(caps.body.engine.code).toBe('hf-token-missing');

      const res = await t.agent
        .post('/api/transcriptions')
        .attach('file', makeWav(0.25), { filename: 'blocked.wav', contentType: 'audio/wav' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('engine-unavailable');
      expect(res.body.code).toBe('hf-token-missing');
      expect(res.body.message).toMatch(/HF_TOKEN|Hugging Face/i);

      // No job record, no artifacts left behind.
      const list = await t.agent.get('/api/transcriptions/nope');
      expect(list.status).toBe(404);
    } finally {
      await t.cleanup();
    }
  });

  it('python runtime missing -> POST 503', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vbt-backend-test-'));
    const env = { ...process.env };
    delete env['HF_TOKEN'];
    const engine = new MuScriptorEngine({
      pythonBin: '/nonexistent/python3',
      workerPath: FAKE_WORKER,
      model: 'small',
      timeoutMs: 5_000,
      env,
    });
    const ctx = await buildContext({ config: { uploadDir: path.join(tmpRoot, 'uploads'), rateLimitMax: 10_000 }, engine });
    try {
      const app = createApp(ctx);
      const agent = request(app);
      // /api/capabilities answers from the last known state, so seed the SAME
      // real probe the background warm-up would run before asserting.
      await ctx.availability.refresh();
      const caps = await agent.get('/api/capabilities');
      expect(caps.body.engine.available).toBe(false);
      expect(caps.body.engine.code).toBe('python-not-found');

      const res = await agent
        .post('/api/transcriptions')
        .attach('file', makeWav(0.25), { filename: 'blocked.wav', contentType: 'audio/wav' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('engine-unavailable');
    } finally {
      await ctx.dispose();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('no response body ever contains the HF token value', async () => {
    const token = 'hf_TESTMARKER_nevertobeexposed';
    const env = { ...process.env, HF_TOKEN: token };
    const engine = new MuScriptorEngine({
      pythonBin: 'python3',
      workerPath: FAKE_WORKER,
      model: 'small',
      timeoutMs: 5_000,
      env,
    });
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vbt-backend-test-'));
    const ctx = await buildContext({ config: { uploadDir: path.join(tmpRoot, 'uploads'), rateLimitMax: 10_000 }, engine });
    try {
      const app = createApp(ctx);
      const agent = request(app);
      await ctx.availability.refresh();
      const caps = await agent.get('/api/capabilities');
      expect(JSON.stringify(caps.body)).not.toContain(token);
      const health = await agent.get('/api/health');
      expect(JSON.stringify(health.body)).not.toContain(token);
      const missing = await agent.get('/api/transcriptions/does-not-exist');
      expect(JSON.stringify(missing.body)).not.toContain(token);

      // The token-bearing engine also runs a real job here: neither the job
      // view nor any artifact/playback route may echo the secret.
      const created = await agent
        .post('/api/transcriptions')
        .attach('file', makeWav(0.25), { filename: 'token.wav', contentType: 'audio/wav' })
        .field('instrument', 'piano')
        .field('sheetType', 'piano-grand');
      expect(created.status).toBe(202);
      const id = created.body.id as string;
      const done = await waitForTerminal(agent, id);
      expect(JSON.stringify(done.body)).not.toContain(token);

      const bodies: unknown[] = [
        (await agent.get(`/api/transcriptions/${id}`)).body,
        (await agent.get(`/api/artifacts/${id}/musicxml`)).text,
        (await agent.get(`/api/artifacts/${id}/midi`)).body,
        (await agent.post(`/api/artifacts/${id}/playback`)).body,
        (await agent.get(`/api/artifacts/${id}/audio`)).body,
        (await agent.post('/api/transcriptions')).body,
      ];
      for (const body of bodies) {
        expect(JSON.stringify(body)).not.toContain(token);
        expect(String(body)).not.toMatch(/HF_TOKEN=/);
      }
    } finally {
      await ctx.dispose();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
