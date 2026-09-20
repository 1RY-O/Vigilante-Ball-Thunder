import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeTestApp, makeWav, waitForTerminal } from './helpers.js';
import type { TestApp } from './helpers.js';

/**
 * POST /api/artifacts/:id/playback + GET /api/artifacts/:id/audio.
 *
 * Honesty rules under test:
 *  - missing FluidSynth  -> 503 fluidsynth-missing (never fake audio)
 *  - missing SoundFont   -> 503 soundfont-missing
 *  - no completed job    -> 409
 *  - unknown job         -> 404
 *  - a real render is only ever advertised AFTER it produced a readable WAV
 *
 * The positive path uses a TEST-DOUBLE synthesizer binary (a tiny Node script
 * that writes a short silent WAV). It is NOT a synthesizer: it exists so the
 * backend's own plumbing — argument order, WAV duration measurement, serving
 * headers — can be verified on a machine without FluidSynth or a 200 MB
 * SoundFont.
 */

/** A path that cannot exist, so the "not installed" branch is real, not mocked. */
const MISSING_FLUIDSYNTH = '/nonexistent/vbt-test/fluidsynth';

interface RenderDouble {
  /** Directory holding the double + its dummy soundfont. */
  dir: string;
  bin: string;
  soundfont: string;
  /** Where the double records the argv the backend passed. */
  argvFile: string;
}

/**
 * Write the stub synthesizer (executable) plus a dummy SoundFont file. The
 * dummy is only there so the "is a SoundFont configured?" probe passes; a real
 * FluidSynth would reject it, which is exactly why this double must never be
 * used outside tests.
 */
async function makeRenderDouble(): Promise<RenderDouble> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vbt-playback-double-'));
  const bin = path.join(dir, 'fake-fluidsynth.cjs');
  const soundfont = path.join(dir, 'dummy-test-soundfont.sf2');
  const argvFile = path.join(dir, 'argv.json');
  await fs.writeFile(soundfont, 'TEST DOUBLE — not a real SoundFont');
  await fs.writeFile(
    bin,
    [
      '#!/usr/bin/env node',
      "'use strict';",
      '// TEST DOUBLE: writes a short silent WAV. Not a synthesizer.',
      "const fs = require('node:fs');",
      'const argv = process.argv.slice(2);',
      "// Answer the availability probe like the real binary (exit 0).",
      "if (argv.includes('--version')) { process.exit(0); }",
      'if (process.env.VBT_DOUBLE_ARGV) fs.writeFileSync(process.env.VBT_DOUBLE_ARGV, JSON.stringify(argv));',
      "const outIndex = argv.indexOf('-F');",
      'if (outIndex < 0 || !argv[outIndex + 1]) { process.stderr.write("no -F\\n"); process.exit(1); }',
      'const sampleRate = 44100;',
      'const frames = Math.floor(sampleRate * 0.25);',
      'const data = Buffer.alloc(frames * 2);',
      'const header = Buffer.alloc(44);',
      "header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);",
      "header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);",
      'header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);',
      'header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);',
      "header.write('data', 36); header.writeUInt32LE(data.length, 40);",
      "fs.writeFileSync(argv[outIndex + 1], Buffer.concat([header, data]));",
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  await fs.chmod(bin, 0o755);
  return { dir, bin, soundfont, argvFile };
}

async function completeJob(t: TestApp, filename = 'play.wav'): Promise<string> {
  const created = await t.agent
    .post('/api/transcriptions')
    .attach('file', makeWav(0.25), { filename, contentType: 'audio/wav' });
  expect(created.status).toBe(202);
  const done = await waitForTerminal(t.agent, created.body.id as string);
  expect(done.body['status']).toBe('complete');
  return created.body.id as string;
}


describe('POST /api/artifacts/:id/playback — honest refusals', () => {
  it('404 for an unknown job', async () => {
    const t = await makeTestApp({ engine: 'stub' });
    try {
      const res = await t.agent.post('/api/artifacts/does-not-exist/playback');
      expect(res.status).toBe(404);
    } finally {
      await t.cleanup();
    }
  });

  it('409 before the transcription has completed (no audio invented early)', async () => {
    const t = await makeTestApp({ engine: 'muscriptor-fake', workerMode: 'sleep' });
    try {
      const created = await t.agent
        .post('/api/transcriptions')
        .attach('file', makeWav(0.25), { filename: 'running.wav', contentType: 'audio/wav' });
      expect(created.status).toBe(202);
      const res = await t.agent.post(`/api/artifacts/${created.body.id}/playback`);
      expect(res.status).toBe(409);
      // The artifact route agrees: nothing to serve yet.
      const audio = await t.agent.get(`/api/artifacts/${created.body.id}/audio`);
      expect(audio.status).toBe(409);
      // Cancel the in-flight job so teardown is clean.
      const cancelled = await t.agent.delete(`/api/transcriptions/${created.body.id}`);
      expect(cancelled.status).toBe(200);
    } finally {
      await t.cleanup();
    }
  });

  it('503 fluidsynth-missing when FluidSynth is not installed — and no audioUrl appears', async () => {
    const t = await makeTestApp({ engine: 'stub', config: { fluidsynthBin: MISSING_FLUIDSYNTH } });
    try {
      const id = await completeJob(t);
      const res = await t.agent.post(`/api/artifacts/${id}/playback`);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('playback-unavailable');
      expect(res.body.code).toBe('fluidsynth-missing');
      expect(String(res.body.message)).toMatch(/fluidsynth/i);
      // Nothing path-shaped leaks.
      expect(JSON.stringify(res.body)).not.toMatch(/\/nonexistent|\/tmp|\/run\//);

      const audio = await t.agent.get(`/api/artifacts/${id}/audio`);
      expect(audio.status).toBe(409); // never a silent placeholder

      // The job view must not advertise playback it does not have.
      const job = await t.agent.get(`/api/transcriptions/${id}`);
      expect((job.body['result'] as Record<string, unknown>)['audioUrl']).toBeUndefined();
    } finally {
      await t.cleanup();
    }
  });

  it('503 soundfont-missing when FluidSynth exists but no SoundFont is configured', async () => {
    const double = await makeRenderDouble();
    const t = await makeTestApp({
      engine: 'stub',
      config: { fluidsynthBin: double.bin, soundfontPath: '' },
    });
    try {
      const id = await completeJob(t);
      const res = await t.agent.post(`/api/artifacts/${id}/playback`);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('playback-unavailable');
      expect(res.body.code).toBe('soundfont-missing');
      expect(String(res.body.message)).toMatch(/soundfont|SOUNDFONT_PATH/i);
    } finally {
      await t.cleanup();
      await fs.rm(double.dir, { recursive: true, force: true });
    }
  });

  it('capabilities reports playback availability honestly', async () => {
    const missing = await makeTestApp({ engine: 'stub', config: { fluidsynthBin: MISSING_FLUIDSYNTH } });
    try {
      const caps = await missing.agent.get('/api/capabilities');
      expect(caps.body.playback.available).toBe(false);
      expect(caps.body.playback.code).toBe('fluidsynth-missing');
      expect(String(caps.body.playback.reason)).toMatch(/fluidsynth/i);
    } finally {
      await missing.cleanup();
    }
  });
});

describe('POST /api/artifacts/:id/playback — real plumbing (TEST-DOUBLE synthesizer)', () => {
  it('renders, serves the WAV with correct headers, and only then advertises audioUrl', async () => {
    const double = await makeRenderDouble();
    process.env['VBT_DOUBLE_ARGV'] = double.argvFile;
    const t = await makeTestApp({
      engine: 'stub',
      config: { fluidsynthBin: double.bin, soundfontPath: double.soundfont },
    });
    try {
      const caps = await t.agent.get('/api/capabilities');
      expect(caps.body.playback.available).toBe(true);

      const id = await completeJob(t);
      const res = await t.agent.post(`/api/artifacts/${id}/playback`);
      expect(res.status).toBe(200);
      expect(res.body.audioUrl).toBe(`/api/artifacts/${id}/audio`);
      // 0.25 s of WAV written by the double, measured from that file's header.
      expect(res.body.durationSec).toBeCloseTo(0.25, 2);

      // Argument order mirrors muscriptor's auralization call: options BEFORE
      // the positional soundfont/MIDI arguments.
      const argv = JSON.parse(await fs.readFile(double.argvFile, 'utf8')) as string[];
      expect(argv.slice(0, 6)).toEqual(['-ni', '-F', argv[2], '-r', '44100', double.soundfont]);
      expect(argv[6]).toContain('transcription.mid');

      const audio = await t.agent.get(res.body.audioUrl as string).buffer(true).parse((res2, cb) => {
        const chunks: Buffer[] = [];
        res2.on('data', (c: Buffer) => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(audio.status).toBe(200);
      expect(audio.headers['content-type']).toContain('audio/wav');
      expect(audio.headers['cache-control']).toBe('private');
      expect(Number(audio.headers['content-length'])).toBe(audio.body.length);
      expect(audio.body.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(audio.body.subarray(8, 12).toString('ascii')).toBe('WAVE');

      // Only now does the job view carry the audio URL.
      const job = await t.agent.get(`/api/transcriptions/${id}`);
      expect((job.body['result'] as Record<string, unknown>)['audioUrl']).toBe(
        `/api/artifacts/${id}/audio`,
      );

      // Idempotent: a second request reuses the render instead of paying again.
      const again = await t.agent.post(`/api/artifacts/${id}/playback`);
      expect(again.status).toBe(200);
      expect(again.body.audioUrl).toBe(res.body.audioUrl);
    } finally {
      delete process.env['VBT_DOUBLE_ARGV'];
      await t.cleanup();
      await fs.rm(double.dir, { recursive: true, force: true });
    }
  });

  it('500 playback-failed when the synthesizer writes no usable audio (never a fake success)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vbt-playback-broken-'));
    const bin = path.join(dir, 'broken-fluidsynth.cjs');
    const soundfont = path.join(dir, 'dummy.sf2');
    await fs.writeFile(soundfont, 'TEST DOUBLE');
    // Exits 0 but writes nothing — exactly what fluidsynth >= 2.5 does when
    // options are passed in the wrong order, so it must never look like success.
    await fs.writeFile(bin, ['#!/usr/bin/env node', "'use strict';", 'process.exit(0);', ''].join('\n'));
    await fs.chmod(bin, 0o755);
    const t = await makeTestApp({
      engine: 'stub',
      config: { fluidsynthBin: bin, soundfontPath: soundfont },
    });
    try {
      const id = await completeJob(t);
      const res = await t.agent.post(`/api/artifacts/${id}/playback`);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('playback-failed');
      expect(res.body.code).toBe('render-failed');
    } finally {
      await t.cleanup();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

