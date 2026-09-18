import { afterAll, describe, expect, it } from 'vitest';

import { makeTestApp } from './helpers.js';

// These tests exercise the REAL MuScriptorEngine class through a
// protocol-faithful FAKE python worker (test fixture) — no gated weights, no
// network — to prove availability reporting is honest.

describe('GET /api/capabilities', () => {
  describe('with the stub (MOCK) engine', () => {
    let t: Awaited<ReturnType<typeof makeTestApp>>;
    afterAll(() => t?.cleanup());

    it('reports the engine as mock explicitly', async () => {
      t = await makeTestApp({ engine: 'stub' });
      const res = await t.agent.get('/api/capabilities');
      expect(res.status).toBe(200);
      expect(res.body.formats).toEqual(['wav', 'mp3', 'flac']);
      expect(Number.isSafeInteger(res.body.maxUploadBytes) && res.body.maxUploadBytes > 0).toBe(true);
      expect(res.body.engine.name).toBe('stub');
      // The mock MUST be labeled as mock in the API.
      expect(res.body.engine.mock).toBe(true);
      expect(res.body.engine.available).toBe(true);
    });
  });

  describe('with the real engine class and a working worker', () => {
    let t: Awaited<ReturnType<typeof makeTestApp>>;
    afterAll(() => t?.cleanup());

    it('reports availability truthfully', async () => {
      t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'ok' });
      const res = await t.agent.get('/api/capabilities');
      expect(res.status).toBe(200);
      expect(res.body.engine.name).toBe('muscriptor');
      expect(res.body.engine.mock).toBe(false);
      expect(res.body.engine.available).toBe(true);
      expect(res.body.engine.model).toBe('small');
    });
  });

  describe('with the worker reporting a missing HF token', () => {
    let t: Awaited<ReturnType<typeof makeTestApp>>;
    afterAll(() => t?.cleanup());

    it('honestly reports unavailability with a safe reason', async () => {
      t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'no-token' });
      const res = await t.agent.get('/api/capabilities');
      expect(res.status).toBe(200); // the API itself is up; the engine is not
      expect(res.body.engine.available).toBe(false);
      expect(res.body.engine.mock).toBe(false);
      expect(res.body.engine.reason).toMatch(/hf token|HF_TOKEN/i);
    });
  });

  it('GET /api/health reports liveness without leaking env', async () => {
    const t = await makeTestApp({ engine: 'stub' });
    try {
      const res = await t.agent.get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body).not.toHaveProperty('HF_TOKEN');
      expect(res.body).not.toHaveProperty('env');
    } finally {
      await t.cleanup();
    }
  });
});
