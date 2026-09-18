import { afterAll, describe, expect, it } from 'vitest';

import { makeTestApp, makeWav, waitForTerminal } from './helpers.js';

// Full lifecycle (queued -> transcribing -> complete) + artifact download.
// Two engines are exercised: the labeled MOCK stub engine, and the real
// MuScriptorEngine class driven by the protocol-faithful FAKE python worker
// (test fixture, no weights). Artifact assertions are strict: no real
// content is ever fabricated by the app itself.

function expectPublicJobShape(body: Record<string, unknown>): void {
  expect(typeof body['id']).toBe('string');
  expect(['queued', 'transcribing', 'complete', 'error']).toContain(body['status']);
}

describe('job lifecycle with stub (MOCK) engine', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  afterAll(() => t?.cleanup());

  it('completes and serves artifacts with correct MIME types', async () => {
    t = await makeTestApp({ engine: 'stub' });

    const created = await t.agent
      .post('/api/transcriptions')
      .attach('file', makeWav(0.25), { filename: 'melody.wav', contentType: 'audio/wav' });
    expect(created.status).toBe(202);
    expectPublicJobShape(created.body);

    const done = await waitForTerminal(t.agent, created.body.id as string);
    expect(done.body['status']).toBe('complete');
    const result = done.body['result'] as { musicxmlUrl: string; midiUrl: string };
    expect(result.musicxmlUrl).toBe(`/api/artifacts/${created.body.id}/musicxml`);
    expect(result.midiUrl).toBe(`/api/artifacts/${created.body.id}/midi`);

    const xml = await t.agent.get(result.musicxmlUrl as string).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(xml.status).toBe(200);
    expect(xml.headers['content-type']).toContain('application/vnd.recordare.musicxml+xml');
    expect(xml.headers['content-disposition']).toContain('.musicxml');
    expect(xml.body.toString('utf8')).toContain('score-partwise');

    const midi = await t.agent.get(result.midiUrl).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(midi.status).toBe(200);
    expect(midi.headers['content-type']).toContain('audio/midi');
    expect(midi.headers['content-disposition']).toContain('.mid');
    expect(midi.body.subarray(0, 4).toString('ascii')).toBe('MThd');
  });
});

describe('job lifecycle with the real subprocess engine (FAKE worker)', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  afterAll(() => t?.cleanup());

  it('queued -> transcribing -> complete with engine-reported progress', async () => {
    t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'ok' });

    const created = await t.agent
      .post('/api/transcriptions')
      .attach('file', makeWav(0.25), { filename: 'take.wav', contentType: 'audio/wav' });
    expect(created.status).toBe(202);
    expect(created.body.status).toBe('queued');

    // Observe at least one pollable state (post-completion allowed).
    const transitional = await t.agent.get(`/api/transcriptions/${created.body.id}`);
    expect(['queued', 'transcribing', 'complete']).toContain(transitional.body.status);
    if (transitional.body.status !== 'complete') {
      // progress must be an engine-reported number when present
      if (transitional.body.progress !== undefined) {
        expect(Number.isInteger(transitional.body.progress)).toBe(true);
        expect(transitional.body.progress).toBeGreaterThanOrEqual(0);
        expect(transitional.body.progress).toBeLessThanOrEqual(100);
      }
    }

    const done = await waitForTerminal(t.agent, created.body.id as string);
    expect(done.body['status']).toBe('complete');
    expect(done.body['progress']).toBe(100);
    const result = done.body['result'] as { musicxmlUrl: string; midiUrl: string };

    const xml = await t.agent.get(result.musicxmlUrl);
    expect(xml.status).toBe(200);
    expect(xml.text).toContain('score-partwise');

    const midiRes = await t.agent.get(result.midiUrl).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(midiRes.body.subarray(0, 4).toString('ascii')).toBe('MThd');
  });

  it('GET job of unknown id returns 404', async () => {
    const res = await t.agent.get('/api/transcriptions/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('artifacts of unknown id return 404', async () => {
    const res = await t.agent.get('/api/artifacts/does-not-exist/musicxml');
    expect(res.status).toBe(404);
  });
});
