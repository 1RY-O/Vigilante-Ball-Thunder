import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { RemoteMuScriptorEngine } from '../src/services/transcription/remoteEngine.js';
import { CancelledError, EngineUnavailableError, TranscriptionError } from '../src/services/transcription/engine.js';
import type { TranscribeRequest } from '../src/services/transcription/engine.js';

/**
 * Remote engine honesty + async-protocol guards. The worker speaks
 * submit/poll (POST /transcribe -> 202 {jobId}, GET /jobs/{id} ->
 * processing/completed/error), so every stub below implements that
 * protocol: the engine must refuse to fabricate artifacts, surface
 * unreachable workers as 503-class errors, and write nothing when the
 * worker's payload is invalid.
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

  function req(audioPath: string, outDir: string, signal?: AbortSignal): TranscribeRequest {
    return {
      audioPath,
      outDir,
      model: 'small',
      sheetType: 'melody-chords',
      instrumentGroups: [],
      signal: signal ?? AbortSignal.timeout(20_000),
    };
  }

  /** Scripted async worker: 202 on submit, then the given poll bodies in order. */
  async function startAsyncStub(pollBodies: unknown[], submitStatus = 202): Promise<{ server: Server; url: string; seen: { posts: number; polls: number } }> {
    const seen = { posts: 0, polls: 0 };
    const server = createServer((nodeReq: IncomingMessage, res: ServerResponse) => {
      nodeReq.resume();
      nodeReq.on('end', () => {
        res.writeHead(submitStatus === 202 && nodeReq.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
        if (nodeReq.method === 'POST' && nodeReq.url === '/transcribe') {
          seen.posts += 1;
          res.end(JSON.stringify({ jobId: 'abc123', status: 'processing' }));
          return;
        }
        seen.polls += 1;
        const body = pollBodies[Math.min(seen.polls - 1, pollBodies.length - 1)];
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, url, seen };
  }

  const GOOD_RESULT = (midiB64: string) => ({
    status: 'completed',
    result: {
      midiBase64: midiB64,
      musicXml: '<?xml version="1.0"?><score-partwise version="4.0"><part id="P1"/></score-partwise>',
      metadata: { durationSec: 15.0, detectedInstruments: ['piano'], tempoBpm: 120, keyName: 'C minor' },
    },
  });

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

  it('submits then polls to completion, writing both real artifacts', async () => {
    const midiBytes = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0x00]);
    const { server, url, seen } = await startAsyncStub([
      { status: 'processing' },
      { status: 'processing' },
      GOOD_RESULT(midiBytes.toString('base64')),
    ]);
    try {
      const engine = new RemoteMuScriptorEngine(url);
      expect((await engine.available()).ok).toBe(true);
      const audioPath = await fixtureWav();
      const outDir = path.join(tmpRoot, 'out');
      const result = await engine.transcribe(req(audioPath, outDir), () => {});
      expect(seen.posts).toBe(1);
      expect(seen.polls).toBeGreaterThanOrEqual(2);
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
    const { server, url } = await startAsyncStub([{
      status: 'completed',
      result: {
        midiBase64: Buffer.from([1, 2, 3]).toString('base64'),
        musicXml: '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"></score-partwise>',
        metadata: { durationSec: null, detectedInstruments: null },
      },
    }]);
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

  it('surfaces a worker-side job failure as TranscriptionError', async () => {
    const { server, url } = await startAsyncStub([
      { status: 'processing' },
      { status: 'error', message: 'boom subprocess died' },
    ]);
    try {
      const engine = new RemoteMuScriptorEngine(url);
      const audioPath = await fixtureWav();
      await expect(
        engine.transcribe(req(audioPath, path.join(tmpRoot, 'out-err')), () => {}),
      ).rejects.toThrow(/boom subprocess died/);
    } finally {
      server.close();
    }
  });

  it('maps a lost job (404 on poll) to TranscriptionError, not success', async () => {
    const server = createServer((nodeReq: IncomingMessage, res: ServerResponse) => {
      nodeReq.resume();
      nodeReq.on('end', () => {
        if (nodeReq.method === 'POST') {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobId: 'gone', status: 'processing' }));
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'not_found' }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const engine = new RemoteMuScriptorEngine(url);
      const audioPath = await fixtureWav();
      await expect(
        engine.transcribe(req(audioPath, path.join(tmpRoot, 'out-gone')), () => {}),
      ).rejects.toBeInstanceOf(TranscriptionError);
    } finally {
      server.close();
    }
  });

  it('aborts a hung poll as CancelledError when the job is cancelled', async () => {
    const { server, url } = await startAsyncStub([{ status: 'processing' }]);
    try {
      const engine = new RemoteMuScriptorEngine(url);
      const audioPath = await fixtureWav();
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 2500).unref();
      await expect(
        engine.transcribe(req(audioPath, path.join(tmpRoot, 'out-cancel'), ctl.signal), () => {}),
      ).rejects.toBeInstanceOf(CancelledError);
    } finally {
      server.close();
    }
  });

  it('maps unreachable worker during submit to EngineUnavailableError', async () => {
    const engine = new RemoteMuScriptorEngine('http://127.0.0.1:9');
    const audioPath = await fixtureWav();
    await expect(
      engine.transcribe(req(audioPath, path.join(tmpRoot, 'out-x')), () => {}),
    ).rejects.toBeInstanceOf(EngineUnavailableError);
  });
});
