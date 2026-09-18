import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestApp, makeWav } from './helpers.js';

// Upload hardening: type, size, content-agreement and duration checks run
// BEFORE any job is created. Uses the labeled MOCK stub engine so jobs would
// succeed if validation passed — failures here are therefore pure validation.

describe('POST /api/transcriptions upload validation', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  beforeAll(async () => {
    t = await makeTestApp({ engine: 'stub' });
  });
  afterAll(() => t.cleanup());

  it('rejects a request without a file (400)', async () => {
    const res = await t.agent.post('/api/transcriptions').field('model', 'small');
    expect(res.status).toBe(400);
  });

  it('rejects clearly unsupported types (415)', async () => {
    const res = await t.agent
      .post('/api/transcriptions')
      .attach('file', Buffer.from('plain text, not audio'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(415);
  });

  it('rejects extension/content mismatch (415)', async () => {
    const res = await t.agent
      .post('/api/transcriptions')
      .attach('file', makeWav(0.05), { filename: 'song.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/extension|match/i);
  });

  it('rejects empty files (415)', async () => {
    const res = await t.agent
      .post('/api/transcriptions')
      .attach('file', Buffer.alloc(0), { filename: 'empty.wav', contentType: 'audio/wav' });
    expect(res.status).toBe(415);
  });

  it('rejects over-size files (413)', async () => {
    const big = Buffer.concat([makeWav(0.01), Buffer.alloc(64 * 1024, 0xab)]);
    const small = await makeTestApp({ engine: 'stub', config: { maxUploadBytes: 8 * 1024 } });
    try {
      const res = await small.agent
        .post('/api/transcriptions')
        .attach('file', big, { filename: 'big.wav', contentType: 'audio/wav' });
      expect(res.status).toBe(413);
    } finally {
      await small.cleanup();
    }
  });

  it('rejects over-duration WAV (415)', async () => {
    const strict = await makeTestApp({ engine: 'stub', config: { maxAudioDurationSec: 1 } });
    try {
      const res = await strict.agent
        .post('/api/transcriptions')
        .attach('file', makeWav(2), { filename: 'long.wav', contentType: 'audio/wav' });
      expect(res.status).toBe(415);
      expect(res.body.error).toMatch(/too long/i);
    } finally {
      await strict.cleanup();
    }
  });

  it('rejects unsupported model names (400)', async () => {
    const res = await t.agent
      .post('/api/transcriptions')
      .field('model', 'mega-xl')
      .attach('file', makeWav(0.05), { filename: 'ok.wav', contentType: 'audio/wav' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model/i);
  });

  it('leaves no staged file behind on validation failure', async () => {
    const before = await t.agent
      .post('/api/transcriptions')
      .attach('file', Buffer.from('not audio'), { filename: 'bad.txt', contentType: 'text/plain' });
    expect(before.status).toBe(415);
    // Stub engine uploads dir should have no leftover staged files
    // (job dirs only exist for accepted jobs).
    const { readdirSync } = await import('node:fs');
    const leftover = readdirSync(t.tmpRoot + '/uploads', { withFileTypes: true }).filter((e) => e.isFile());
    expect(leftover).toEqual([]);
  });
});
