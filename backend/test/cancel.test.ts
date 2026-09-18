import { afterAll, describe, expect, it } from 'vitest';

import { makeTestApp, makeWav, waitForTerminal } from './helpers.js';

// DELETE /api/transcriptions/:id — safe cancellation. Uses the real
// MuScriptorEngine class + the FAKE worker in 'sleep' mode so a running job
// exists long enough to cancel. Concurrency is 1: job #1 runs, job #2 queues.

describe('DELETE /api/transcriptions/:id', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  afterAll(() => t?.cleanup());

  it('cancels queued jobs and kills running ones (settling as error cancelled)', async () => {
    t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'sleep' });

    const first = await t.agent
      .post('/api/transcriptions')
      .attach('file', makeWav(0.25), { filename: 'one.wav', contentType: 'audio/wav' });
    expect(first.status).toBe(202);

    // Wait until job #1 is actually running.
    let state = first.body.status;
    const started = Date.now();
    while (state === 'queued' && Date.now() - started < 10_000) {
      await new Promise((r) => setTimeout(r, 25));
      state = (await t.agent.get(`/api/transcriptions/${first.body.id}`)).body.status;
    }
    expect(state).toBe('transcribing');

    const second = await t.agent
      .post('/api/transcriptions')
      .attach('file', makeWav(0.25), { filename: 'two.wav', contentType: 'audio/wav' });
    expect(second.status).toBe(202);
    expect((await t.agent.get(`/api/transcriptions/${second.body.id}`)).body.status).toBe('queued');

    // Cancel the queued job: settles immediately as error{cancelled}.
    const cancelledSecond = await t.agent.delete(`/api/transcriptions/${second.body.id}`);
    expect(cancelledSecond.status).toBe(200);
    expect(cancelledSecond.body.status).toBe('error');
    expect(cancelledSecond.body.error).toMatchObject({ code: 'cancelled' });
    const afterQueued = await t.agent.get(`/api/transcriptions/${second.body.id}`);
    expect(afterQueued.body.status).toBe('error');
    expect(afterQueued.body.error).toMatchObject({ code: 'cancelled' });

    // Cancel the running job: worker gets killed; terminal state is cancelled.
    const cancelledFirst = await t.agent.delete(`/api/transcriptions/${first.body.id}`);
    expect(cancelledFirst.status).toBe(200);
    const done = await waitForTerminal(t.agent, first.body.id as string);
    expect(done.body['status']).toBe('error');
    expect(done.body['error']).toMatchObject({ code: 'cancelled' });

    // Unknown id -> 404.
    const missing = await t.agent.delete('/api/transcriptions/nope');
    expect(missing.status).toBe(404);
  }, 30_000);

  it('cancelling an already-terminal job is a safe no-op (idempotent)', async () => {
    const ok = await makeTestApp({ engine: 'stub' });
    try {
      const created = await ok.agent
        .post('/api/transcriptions')
        .attach('file', makeWav(0.25), { filename: 'done.wav', contentType: 'audio/wav' });
      const done = await waitForTerminal(ok.agent, created.body.id as string);
      expect(done.body['status']).toBe('complete');
      const res = await ok.agent.delete(`/api/transcriptions/${created.body.id}`);
      expect(res.status).toBe(200);
      // Still complete, artifacts still downloadable — cancel never destroys
      // a finished result.
      expect(res.body.status).toBe('complete');
      const xml = await ok.agent.get(`/api/artifacts/${created.body.id}/musicxml`);
      expect(xml.status).toBe(200);
    } finally {
      await ok.cleanup();
    }
  });
});
