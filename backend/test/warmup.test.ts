import { describe, expect, it } from 'vitest';

import { AvailabilityMonitor } from '../src/services/transcription/availabilityMonitor.js';
import { availabilityLogLine } from '../src/services/transcription/availabilityLog.js';
import { ENGINE_WARMING_UP_CODE, SELF_CHECK_TIMEOUT_CODE } from '../src/services/transcription/engine.js';
import type { EngineAvailability, TranscriptionEngine } from '../src/services/transcription/engine.js';
import { MuScriptorEngine } from '../src/services/transcription/muScriptorEngine.js';
import { FAKE_WORKER, makeTestApp, makeWav, waitForTerminal } from './helpers.js';

/**
 * Cold-start behaviour: a MuScriptor availability check imports torch and
 * probes the gated weights (45-60s on an 8GB CPU-only laptop), so no HTTP
 * request may wait for one and a slow check must never be reported as a real
 * failure. The subprocess cases use the REAL MuScriptorEngine class + the
 * protocol-faithful FAKE python worker (test fixture, no weights).
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test double engine used ONLY for monitor unit tests (no subprocess at all). */
class CountingEngine implements TranscriptionEngine {
  readonly name = 'availability-monitor-test-double';
  readonly isMock = true;
  calls = 0;
  constructor(private readonly script: EngineAvailability[]) {}
  async available(): Promise<EngineAvailability> {
    this.calls += 1;
    await sleep(30); // non-zero to prove callers never block on it
    return this.script[Math.min(this.calls - 1, this.script.length - 1)] ?? { ok: false };
  }
  transcribe(): Promise<never> {
    return Promise.reject(new Error('the counting test double never transcribes'));
  }
}

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await sleep(25);
  }
}

describe('startup log wording (code-driven, never message-driven)', () => {
  it('reports a cold-start timeout as warming up, not as a failure', () => {
    const line = availabilityLogLine(
      { selfCheckTimeoutMs: 120_000 },
      {
        ok: false,
        code: SELF_CHECK_TIMEOUT_CODE,
        reason: 'MuScriptor did not finish its availability check within 120s.',
      },
    );
    expect(line.level).toBe('warn');
    expect(line.text).toMatch(/^MuScriptor engine warming up \(first check exceeded 120s/);
    expect(line.text).toContain('will retry in background');
    expect(line.text).not.toContain('NOT available');
  });

  it('keeps a clear "NOT available" message for real blockers', () => {
    for (const code of [
      'hf-token-missing',
      'worker-deps-missing',
      'python-not-found',
      'weights-gated',
      'hf-unreachable',
    ]) {
      const line = availabilityLogLine({ selfCheckTimeoutMs: 120_000 }, { ok: false, code, reason: 'curated reason' });
      expect(line.level).toBe('warn');
      expect(line.text).toContain('NOT available');
      expect(line.text).toContain(code);
    }
  });

  it('reports readiness at info level', () => {
    const line = availabilityLogLine({ selfCheckTimeoutMs: 120_000 }, { ok: true });
    expect(line.level).toBe('info');
    expect(line.text).toMatch(/ready/);
  });
});

describe('AvailabilityMonitor warm-up (no HTTP)', () => {
  it('never blocks readers, dedupes probes, and stops polling once available', async () => {
    const engine = new CountingEngine([{ ok: true }]);
    const monitor = new AvailabilityMonitor(engine, 250);
    try {
      const first = monitor.snapshot();
      expect(first.value).toBeNull(); // no state before the first probe lands
      expect(first.checking).toBe(true); // but a probe IS running

      // Repeated reads must not spawn extra probes: one real check is in flight.
      monitor.snapshot();
      monitor.snapshot();
      await sleep(80);
      expect(engine.calls).toBe(1);

      monitor.start(); // production warm-up entry point
      await waitForCondition(async () => monitor.snapshot().value?.ok === true);
      const callsWhenReady = engine.calls;

      // Available => the poller must stop (no orphan timers/processes).
      await sleep(800);
      expect(engine.calls).toBe(callsWhenReady);
    } finally {
      monitor.stop();
    }
  });

  it('keeps polling while the engine is not available', async () => {
    const engine = new CountingEngine([{ ok: false, code: 'hf-token-missing' }]);
    const monitor = new AvailabilityMonitor(engine, 250);
    monitor.start();
    try {
      await waitForCondition(async () => monitor.snapshot().value?.ok === false);
      const callsAfterFirstProbe = engine.calls;
      await sleep(700);
      expect(engine.calls).toBeGreaterThan(callsAfterFirstProbe);
    } finally {
      monitor.stop();
    }
  });
});

describe('cold start over HTTP (real engine class + FAKE worker)', () => {
  it(
    'capabilities answers instantly while warming up and POST refuses honestly (no fake job)',
    async () => {
      const t = await makeTestApp({
        engine: 'muscriptor-fake',
        workerMode: 'delay-self-check', // slow-but-healthy check (~0.6s)
        prewarm: false,
        config: { selfCheckTimeoutMs: 5_000, warmupIntervalMs: 250 },
      });
      try {
        const started = Date.now();
        const caps = await t.agent.get('/api/capabilities');
        const elapsed = Date.now() - started;

        expect(caps.status).toBe(200);
        expect(elapsed).toBeLessThan(400); // must NOT wait for the ~600ms probe
        expect(caps.body.engine.name).toBe('muscriptor');
        expect(caps.body.engine.available).toBe(false);
        expect(caps.body.engine.code).toBe(ENGINE_WARMING_UP_CODE);
        expect(caps.body.engine.checking).toBe(true);
        expect(caps.body.engine.reason).toMatch(/warming up/i);

        // POST mid-warm-up: honest 503 with the unchanged error envelope.
        const blocked = await t.agent
          .post('/api/transcriptions')
          .attach('file', makeWav(0.25), { filename: 'cold.wav', contentType: 'audio/wav' });
        expect(blocked.status).toBe(503);
        expect(blocked.body.error).toBe('engine-unavailable');
        expect(blocked.body.code).toBe(ENGINE_WARMING_UP_CODE);

        // The background probe finishes -> available, still answered instantly.
        await waitForCondition(async () => {
          const res = await t.agent.get('/api/capabilities');
          return res.body.engine.available === true;
        });
        const afterStart = Date.now();
        const warm = await t.agent.get('/api/capabilities');
        expect(Date.now() - afterStart).toBeLessThan(100); // cached, not a live check
        expect(warm.body.engine.checking).toBe(false);

        // ...and a real job is accepted only now.
        const accepted = await t.agent
          .post('/api/transcriptions')
          .attach('file', makeWav(0.25), { filename: 'warm.wav', contentType: 'audio/wav' });
        expect(accepted.status).toBe(202);
        const done = await waitForTerminal(t.agent, accepted.body.id as string);
        expect(done.body['status']).toBe('complete');
      } finally {
        await t.cleanup();
      }
    },
    20_000,
  );

  it(
    'a check that outlives its budget reports self-check-timeout, never a fake "ready"',
    async () => {
      const t = await makeTestApp({
        engine: 'muscriptor-fake',
        workerMode: 'slow-self-check', // sleeps 5s: must be killed at the budget
        config: { selfCheckTimeoutMs: 800, warmupIntervalMs: 250 },
      });
      try {
        const caps = await t.agent.get('/api/capabilities');
        expect(caps.status).toBe(200);
        expect(caps.body.engine.available).toBe(false); // never a fake ready
        expect(caps.body.engine.code).toBe(SELF_CHECK_TIMEOUT_CODE);
        expect(caps.body.engine.reason).toContain('within 1s'); // the real budget

        const res = await t.agent
          .post('/api/transcriptions')
          .attach('file', makeWav(0.25), { filename: 'slow.wav', contentType: 'audio/wav' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe(SELF_CHECK_TIMEOUT_CODE);
      } finally {
        await t.cleanup();
      }
    },
    20_000,
  );
});

describe('shutdown hygiene (no orphan warm-up probe)', () => {
  it('killing an in-flight warm-up check settles honestly, never a fake "ready"', async () => {
    const engine = new MuScriptorEngine({
      pythonBin: 'python3',
      workerPath: FAKE_WORKER, // FAKE worker, 'slow-self-check' mode (5s probe)
      model: 'small',
      timeoutMs: 5_000,
      selfCheckTimeoutMs: 60_000, // budget would keep the child alive a long time
      env: { ...process.env, FAKE_WORKER_MODE: 'slow-self-check' },
    });
    const pending = engine.available(true);
    await sleep(300); // the probe is running and would outlive the server
    const killedAt = Date.now();
    engine.dispose(); // what ctx.dispose() does on SIGINT/SIGTERM
    const result = await pending;
    expect(Date.now() - killedAt).toBeLessThan(2_000); // settled by the kill, not the budget
    expect(result.ok).toBe(false); // never a fake ready
  });
});
