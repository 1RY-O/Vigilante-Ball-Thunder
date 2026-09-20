import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

import { makeTestApp, makeWav, waitForTerminal } from './helpers.js';
import type { TestApp } from './helpers.js';

/**
 * Request options on POST /api/transcriptions: the `instrument` hint and the
 * `sheetType` layout.
 *
 * The API validates the vocabulary; the mapping to muscriptor's MT3_FULL_PLUS
 * group names is asserted against what the REAL MuScriptorEngine class actually
 * passed to the worker (protocol-faithful FAKE worker — test fixture).
 */

function postWith(t: TestApp, fields: Record<string, string> = {}) {
  let req = t.agent
    .post('/api/transcriptions')
    .attach('file', makeWav(0.25), { filename: 'options.wav', contentType: 'audio/wav' });
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
  return req;
}

interface Invocation {
  args: string[];
  sheetType: string;
  instruments: string | null;
}

/** What the engine really handed the worker (fixture bookkeeping). */
async function readInvocation(t: TestApp, id: string): Promise<Invocation> {
  const job = t.ctx.jobManager.getJob(id);
  if (!job) throw new Error(`job ${id} is not known to the job manager`);
  const raw = await fs.readFile(path.join(job.workDir, 'invocation.json'), 'utf8');
  return JSON.parse(raw) as Invocation;
}

describe('instrument hints on POST /api/transcriptions', () => {
  let t: TestApp;
  afterAll(() => t?.cleanup());

  it('accepts the hint vocabulary and passes mapped groups to the worker', async () => {
    t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'ok' });

    const piano = await postWith(t, { instrument: 'piano' });
    expect(piano.status).toBe(202);
    const pianoDone = await waitForTerminal(t.agent, piano.body.id as string);
    expect(pianoDone.body['status']).toBe('complete');
    // piano -> the piano-family groups of muscriptor's MT3_FULL_PLUS vocabulary.
    expect((await readInvocation(t, piano.body.id as string)).instruments).toBe(
      'acoustic_piano,electric_piano',
    );

    const drums = await postWith(t, { instrument: 'drums' });
    const drumsDone = await waitForTerminal(t.agent, drums.body.id as string);
    expect(drumsDone.body['status']).toBe('complete');
    expect((await readInvocation(t, drums.body.id as string)).instruments).toBe('drums');
  });

  it('sends NO instrument constraint for auto (the pre-hint behaviour)', async () => {
    const t2 = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'ok' });
    try {
      const auto = await postWith(t2, { instrument: 'auto' });
      await waitForTerminal(t2.agent, auto.body.id as string);
      const invocation = await readInvocation(t2, auto.body.id as string);
      expect(invocation.instruments).toBeNull();
      expect(invocation.args).not.toContain('--instruments');

      const absent = await postWith(t2);
      await waitForTerminal(t2.agent, absent.body.id as string);
      expect((await readInvocation(t2, absent.body.id as string)).instruments).toBeNull();
    } finally {
      await t2.cleanup();
    }
  });

  it('accepts multi and other as "no usable hint" without inventing a constraint', async () => {
    const t2 = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'ok' });
    try {
      for (const hint of ['multi', 'other']) {
        const created = await postWith(t2, { instrument: hint });
        expect(created.status).toBe(202);
        const done = await waitForTerminal(t2.agent, created.body.id as string);
        expect(done.body['status']).toBe('complete');
        const invocation = await readInvocation(t2, created.body.id as string);
        expect(invocation.instruments).toBeNull();
        expect(invocation.args).not.toContain('--instruments');
      }
    } finally {
      await t2.cleanup();
    }
  });

  it('rejects an unknown hint with 400 and names the accepted values', async () => {
    const t2 = await makeTestApp({ engine: 'stub' });
    try {
      const res = await postWith(t2, { instrument: 'kazoo' });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/instrument/i);
      expect(String(res.body.error)).toContain('kazoo');
      expect(String(res.body.error)).toContain('drums');
    } finally {
      await t2.cleanup();
    }
  });

  it('the MOCK stub engine accepts a hint without error', async () => {
    const t2 = await makeTestApp({ engine: 'stub' });
    try {
      const created = await postWith(t2, { instrument: 'vocals' });
      expect(created.status).toBe(202);
      const done = await waitForTerminal(t2.agent, created.body.id as string);
      expect(done.body['status']).toBe('complete');
    } finally {
      await t2.cleanup();
    }
  });
});

describe('sheet types on POST /api/transcriptions', () => {
  let t: TestApp;
  afterAll(() => t?.cleanup());

  it('defaults to melody-chords and passes the requested layout to the worker', async () => {
    t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'ok' });

    const explicit = await postWith(t, { sheetType: 'melody-chords' });
    expect(explicit.status).toBe(202);
    await waitForTerminal(t.agent, explicit.body.id as string);
    expect((await readInvocation(t, explicit.body.id as string)).sheetType).toBe('melody-chords');

    // The richer layouts ARE implemented by the real engine (music21
    // post-processing), so they are accepted rather than refused.
    const grand = await postWith(t, { sheetType: 'piano-grand' });
    expect(grand.status).toBe(202);
    const grandDone = await waitForTerminal(t.agent, grand.body.id as string);
    expect(grandDone.body['status']).toBe('complete');
    expect((await readInvocation(t, grand.body.id as string)).sheetType).toBe('piano-grand');

    const lead = await postWith(t, { sheetType: 'lead-sheet' });
    expect(lead.status).toBe(202);
    await waitForTerminal(t.agent, lead.body.id as string);
    expect((await readInvocation(t, lead.body.id as string)).sheetType).toBe('lead-sheet');
  });

  it('refuses a layout the MOCK engine cannot genuinely produce (501, no fake job)', async () => {
    const t2 = await makeTestApp({ engine: 'stub' });
    try {
      for (const sheetType of ['piano-grand', 'lead-sheet']) {
        const res = await postWith(t2, { sheetType });
        expect(res.status).toBe(501);
        expect(res.body.error).toBe('not-implemented');
        expect(res.body.code).toBe('sheet-type-unsupported');
        expect(String(res.body.message)).toContain(sheetType);
        expect(String(res.body.message)).not.toMatch(/\/tmp|\/run\/|Traceback/);
      }
      // …while the layout the mock CAN serve still works.
      const ok = await postWith(t2, { sheetType: 'melody-chords' });
      expect(ok.status).toBe(202);
      await waitForTerminal(t2.agent, ok.body.id as string);
    } finally {
      await t2.cleanup();
    }
  });

  it('rejects an unknown sheet type with 400', async () => {
    const t2 = await makeTestApp({ engine: 'stub' });
    try {
      const res = await postWith(t2, { sheetType: 'pdf' });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/sheet type/i);
      expect(String(res.body.error)).toContain('melody-chords');
    } finally {
      await t2.cleanup();
    }
  });

  it('a genuine worker-side layout failure settles as not-implemented, never fake output', async () => {
    const t2 = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'sheet-unsupported' });
    try {
      const created = await postWith(t2, { sheetType: 'piano-grand' });
      expect(created.status).toBe(202); // accepted: the engine supports it
      const done = await waitForTerminal(t2.agent, created.body.id as string);
      expect(done.body['status']).toBe('error');
      const error = done.body['error'] as Record<string, unknown>;
      expect(error['code']).toBe('not-implemented');
      expect(error['cause']).toBe('sheet-type-unsupported');
      const xml = await t2.agent.get(`/api/artifacts/${created.body.id}/musicxml`);
      expect(xml.status).toBe(409); // no artifact was produced
    } finally {
      await t2.cleanup();
    }
  });

  it('capabilities advertises the engine-aware sheet type list', async () => {
    const stub = await makeTestApp({ engine: 'stub' });
    try {
      const caps = await stub.agent.get('/api/capabilities');
      expect(caps.body.sheetTypes.default).toBe('melody-chords');
      expect(caps.body.sheetTypes.supported).toEqual(['melody-chords']);
      expect(caps.body.instrumentHints.values).toContain('piano');
      expect(caps.body.instrumentHints.mapped.piano).toEqual(['acoustic_piano', 'electric_piano']);
      expect(caps.body.instrumentHints.mapped).not.toHaveProperty('auto');
    } finally {
      await stub.cleanup();
    }

    const real = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'ok' });
    try {
      const caps = await real.agent.get('/api/capabilities');
      expect(caps.body.sheetTypes.supported).toEqual(['melody-chords', 'piano-grand', 'lead-sheet']);
    } finally {
      await real.cleanup();
    }
  });
});
