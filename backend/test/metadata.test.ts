import { afterAll, describe, expect, it } from 'vitest';

import { makeTestApp, makeWav, waitForTerminal } from './helpers.js';
import type { TestApp } from './helpers.js';

/**
 * Richer metadata on GET /api/transcriptions/:id.
 *
 * The honest rule under test: every field comes from the engine, and anything
 * the engine did not report is OMITTED or null — never filled in by the API.
 * The values themselves come from the protocol-faithful FAKE worker (a labeled
 * fixture), so these assertions are about the plumbing, not about music.
 */

async function createAndWait(t: TestApp, fields: Record<string, string> = {}) {
  let req = t.agent
    .post('/api/transcriptions')
    .attach('file', makeWav(0.25), { filename: 'meta.wav', contentType: 'audio/wav' });
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
  const created = await req;
  expect(created.status).toBe(202);
  const done = await waitForTerminal(t.agent, created.body.id as string);
  expect(done.body['status']).toBe('complete');
  return { id: created.body.id as string, result: done.body['result'] as Record<string, unknown> };
}

describe('complete-job metadata (real engine class + FAKE worker)', () => {
  let t: TestApp;
  afterAll(() => t?.cleanup());

  it('reports engine provenance, duration, wall clock, instruments and analysis', async () => {
    t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'ok' });
    const { result } = await createAndWait(t);

    // Provenance is the engine's own name + model.
    expect(String(result['engineUsed'])).toContain('muscriptor');
    expect(String(result['engineUsed'])).toContain('small');
    // Duration is what the worker measured (fixture: 1.0s).
    expect(result['durationSec']).toBe(1.0);
    // Wall clock from job start to complete, measured in-process.
    const ms = result['transcriptionMs'];
    expect(typeof ms).toBe('number');
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms as number).toBeGreaterThanOrEqual(0);
    expect(ms as number).toBeLessThan(30_000);
    // Instruments + analysis come straight from result.json (fixture values).
    expect(result['detectedInstruments']).toEqual(['acoustic_piano']);
    expect(result['metadata']).toEqual({ tempoBpm: 123, keyName: 'C major' });
    // Nothing internal leaks into the payload.
    expect(JSON.stringify(result)).not.toMatch(/\/tmp|\/run\/|workDir|uploadPath/);
  });

  it('omits fields the engine did not report instead of inventing them', async () => {
    const t2 = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'no-extras' });
    try {
      const { result } = await createAndWait(t2);
      expect(result['durationSec']).toBeNull();
      expect(result['detectedInstruments']).toBeNull();
      expect(result).not.toHaveProperty('metadata');
      // Provenance and timing are always known, so they are still present.
      expect(String(result['engineUsed'])).toContain('muscriptor');
      expect(typeof result['transcriptionMs']).toBe('number');
    } finally {
      await t2.cleanup();
    }
  });
});

describe('complete-job metadata with the MOCK stub engine', () => {
  it('claims no instruments and no analysis (the mock never ran music21)', async () => {
    const t = await makeTestApp({ engine: 'stub' });
    try {
      const { result } = await createAndWait(t);
      expect(String(result['engineUsed'])).toContain('stub');
      expect(String(result['engineUsed'])).toMatch(/MOCK/i);
      expect(result['detectedInstruments']).toBeNull();
      expect(result).not.toHaveProperty('metadata');
      expect(result['durationSec']).toBe(4.0); // the fixture's own length
      expect(typeof result['transcriptionMs']).toBe('number');
    } finally {
      await t.cleanup();
    }
  });
});
