import { buildContext } from './appContext.js';
import type { AppContext } from './appContext.js';
import { createApp } from './app.js';
import { SELF_CHECK_TIMEOUT_CODE } from './services/transcription/engine.js';
import type { EngineAvailability } from './services/transcription/engine.js';

/**
 * Honest startup wording, branched on the machine-readable code (never on
 * message text): a cold-start timeout means "warming up, will retry" while
 * every other code is a real blocker that stays unavailable.
 */
function logEngineAvailability(ctx: AppContext, a: EngineAvailability): void {
  if (a.ok) {
    console.log('MuScriptor engine: ready (deps installed, HF access verified).');
    return;
  }
  if (a.code === SELF_CHECK_TIMEOUT_CODE) {
    console.warn(
      `MuScriptor engine warming up (first check exceeded ${Math.round(ctx.config.selfCheckTimeoutMs / 1000)}s — will retry in background)`,
    );
    return;
  }
  console.warn(`MuScriptor engine NOT available: ${a.code ?? 'unknown'} — ${a.reason ?? 'no reason given'}`);
}

async function main(): Promise<void> {
  const ctx = await buildContext();
  const app = createApp(ctx);
  const { port, host, engine, model } = ctx.config;

  const server = app.listen(port, host, () => {
    console.log(`Vigilante Ball Thunder backend listening on http://${host}:${port}`);
    if (ctx.engine.isMock) {
      console.warn(
        '[MOCK ENGINE ACTIVE] TRANSCRIPTION_ENGINE=stub — results are synthetic fixture data, NOT real transcription. Do not use for real output.',
      );
      return;
    }
    console.log(`Transcription engine: ${ctx.engine.name} (model: ${model})`);
    // Non-blocking: the first check imports torch and probes the gated
    // weights (45-60s on a CPU-only cold start), so startup must never wait.
    void ctx.engine
      .available()
      .then((a) => logEngineAvailability(ctx, a))
      .catch((e: unknown) =>
        console.warn(
          `MuScriptor engine availability check failed: ${e instanceof Error ? e.message : 'unknown error'}`,
        ),
      );
  });

  // engine name kept in closure for the shutdown log only
  void engine;
  const shutdown = () => {
    void ctx.dispose().finally(() => {
      server.close(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start backend:', err instanceof Error ? err.message : err);
  process.exit(1);
});
