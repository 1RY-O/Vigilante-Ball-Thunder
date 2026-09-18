import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestApp, makeWav, waitForTerminal } from './helpers.js';

describe('API surface hygiene', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  beforeAll(async () => {
    t = await makeTestApp({ engine: 'stub' });
  });
  afterAll(() => t.cleanup());

  it('unknown /api routes return 404 JSON', async () => {
    const res = await t.agent.get('/api/whatever');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('rate limiter answers 429 after the configured burst', async () => {
    const limited = await makeTestApp({
      engine: 'stub',
      config: { rateLimitMax: 2, rateLimitWindowMs: 60_000 },
    });
    try {
      const upload = () =>
        limited.agent
          .post('/api/transcriptions')
          .attach('file', makeWav(0.05), { filename: 'a.wav', contentType: 'audio/wav' });
      const j1 = await upload();
      const j2 = await upload();
      expect(j1.status).toBe(202);
      expect(j2.status).toBe(202);
      const third = await upload();
      expect(third.status).toBe(429);
      // Let in-flight jobs settle before teardown.
      await waitForTerminal(limited.agent, j1.body.id as string);
      await waitForTerminal(limited.agent, j2.body.id as string);
    } finally {
      await limited.cleanup();
    }
  });
});
