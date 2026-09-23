import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { RemoteMuScriptorEngine } from '../src/services/transcription/remoteEngine.js';
import { EngineUnavailableError, TranscriptionError } from '../src/services/transcription/engine.js';
import type { TranscribeRequest } from '../src/services/transcription/engine.js';

/**
 * Remote engine honesty guards: the engine must refuse to fabricate
 * artifacts (no placeholder MusicXML), surface unreachable workers as
 * 503-class errors, and write nothing when the worker's payload is invalid.
 */
describe('RemoteMuScriptorEngine', () => {
  let tmpRoot = '';
  async function fixtureWav(): Promise<string> {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-eng-'));
    const wav = path.join(tmpRoot, 'a.wav');
    // Minimal valid WAV header; the stub remote server ignores content.
    const data = Buffer.alloc(44 + 1600);
    data.write('RIFF', 0); data.writeUInt32LE(36 + 1600, 4); data.write('WAVE', 8);
    await fs.writeFile(wav, data);
    return wav;
  }
  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function req(audioPath: string, outDir: string): TranscribeRequest {
    return {
      audioPath,
      outDir,
      model: 'small',
      sheetType: 'melody-chords',
      instrumentGroups: [],
      signal: AbortSignal.timeout(15_000),
    };
  }

  it('reports offline (not fabricated success) when no worker listens', async () => {
    const engine = new RemoteMuScriptorEngine('http://127.0.0.1:9');
    const avail = await engine.available();
    expect(avail.ok).toBe(false);
    expect(avail.code).toBe('remote-worker-offline');
    expect(engine.isMock).toBe(false);
  });

  it('reports misconfiguration when the URL is empty', async () => {
    const engine = new RemoteMuScriptorEngine('');
    const avail = await engine.available();
    expect(avail.ok).toBe(false);
    expect(avail.code).toBe('remote-worker-unconfigured');
  });

  it('writes both real artifacts and returns worker metadata', async () => {
    const midiBytes = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0x00]);
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        midiBase64: midiBytes.toString('base64'),
        musicXml: '<?xml version="1.0"?><score-partwise version="4.0"><part id="P1"/></score-partwise>',
        metadata: { durationSec: 15.0, detectedInstruments: ['piano'], tempoBpm: 120, keyName: 'C minor' },
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const engine = new RemoteMuScriptorEngine(url);
      expect((await engine.available()).ok).toBe(true);
      const audioPath = await fixtureWav();
      const outDir = path.join(tmpRoot, 'out');
      const result = await engine.transcribe(req(audioPath, outDir), () => {});
      expect((await fs.readFile(result.midiPath)).equals(midiBytes)).toBe(true);
      expect(await fs.readFile(result.musicXmlPath, 'utf8')).toContain('<score-partwise');
      expect(result.engineUsed).toBe('remote-muscriptor (small)');
      expect(result.durationSec).toBe(15.0);
      expect(result.detectedInstruments).toEqual(['piano']);
      expect(result.metadata).toEqual({ tempoBpm: 120, keyName: 'C minor' });
    } finally {
      server.close();
    }
  });

  it('rejects an empty MusicXML shell instead of writing it', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        midiBase64: Buffer.from([1, 2, 3]).toString('base64'),
        musicXml: '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"></score-partwise>',
        metadata: { durationSec: null, detectedInstruments: null },
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const engine = new RemoteMuScriptorEngine(url);
      const audioPath = await fixtureWav();
      const outDir = path.join(tmpRoot, 'out-empty');
      await expect(engine.transcribe(req(audioPath, outDir), () => {})).rejects.toBeInstanceOf(
        TranscriptionError,
      );
      // Nothing partial left behind.
      await expect(fs.stat(path.join(outDir, 'transcription.mid'))).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it('maps unreachable worker during transcribe to EngineUnavailableError', async () => {
    const engine = new RemoteMuScriptorEngine('http://127.0.0.1:9');
    const audioPath = await fixtureWav();
    await expect(
      engine.transcribe(req(audioPath, path.join(tmpRoot, 'out-x')), () => {}),
    ).rejects.toBeInstanceOf(EngineUnavailableError);
  });
});
