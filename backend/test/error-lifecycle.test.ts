import { afterAll, describe, expect, it } from 'vitest';

import { makeTestApp, makeWav, waitForTerminal } from './helpers.js';

// Failure lifecycles (queued -> transcribing -> error). The REAL
// MuScriptorEngine class is driven by the protocol-faithful FAKE worker in
// failing modes; assertions verify honest terminal errors, never fake success.

describe('job failure lifecycle (real engine class, failing FAKE worker)', () => {
  it('model failure ends the job in error with a safe code and no artifacts', async () => {
    const t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'fail' });
    try {
      const created = await t.agent
        .post('/api/transcriptions')
        .attach('file', makeWav(0.25), { filename: 'failing.wav', contentType: 'audio/wav' });
      expect(created.status).toBe(202);

      const done = await waitForTerminal(t.agent, created.body.id as string);
      expect(done.body['status']).toBe('error');
      expect(done.body['error']).toMatchObject({ code: 'transcription-failed' });

      const xml = await t.agent.get(`/api/artifacts/${created.body.id}/musicxml`);
      expect(xml.status).toBe(409); // job exists but produced nothing
      const midi = await t.agent.get(`/api/artifacts/${created.body.id}/midi`);
      expect(midi.status).toBe(409);
    } finally {
      await t.cleanup();
    }
  });

  it('gated-weights failure settles as engine-unavailable with safe cause, not fake success', async () => {
    const t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'gated' });
    try {
      const created = await t.agent
        .post('/api/transcriptions')
        .attach('file', makeWav(0.25), { filename: 'gated.wav', contentType: 'audio/wav' });
      expect(created.status).toBe(202);
      const done = await waitForTerminal(t.agent, created.body.id as string);
      expect(done.body['status']).toBe('error');
      expect(done.body['error']).toMatchObject({ code: 'engine-unavailable' });
      // Cause is the curated worker code (safe), never stderr/paths/tokens.
      expect((done.body['error'] as Record<string, unknown>)['cause']).toBe('weights-gated');
      expect(JSON.stringify(done.body)).not.toMatch(/\/tmp|\/home|\.venv|Traceback/);
    } finally {
      await t.cleanup();
    }
  });

  it('exit 0 with missing artifacts is detected and reported as failure', async () => {
    const t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'no-write' });
    try {
      const created = await t.agent
        .post('/api/transcriptions')
        .attach('file', makeWav(0.25), { filename: 'silent.wav', contentType: 'audio/wav' });
      const done = await waitForTerminal(t.agent, created.body.id as string);
      expect(done.body['status']).toBe('error');
      expect(done.body['error']).toMatchObject({ code: 'transcription-failed' });
    } finally {
      await t.cleanup();
    }
  });

  it('a crashing worker (non-JSON noise, exit 2) fails honestly', async () => {
    const t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'crash' });
    try {
      const created = await t.agent
        .post('/api/transcriptions')
        .attach('file', makeWav(0.25), { filename: 'crash.wav', contentType: 'audio/wav' });
      const done = await waitForTerminal(t.agent, created.body.id as string);
      expect(done.body['status']).toBe('error');
      expect(done.body['error']).toMatchObject({ code: 'transcription-failed' });
    } finally {
      await t.cleanup();
    }
  });
});
