import { buildContext } from './appContext.js';
import { createApp } from './app.js';
import { availabilityLogLine } from './services/transcription/availabilityLog.js';

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
    // Background warm-up: the first probe imports torch and touches the gated
    // weights (45-60s on a CPU-only cold start), so it is fired here, after
    // listen, and never awaited. The monitor keeps re-probing until the engine
    // is available, so /api/capabilities and POST answer instantly meanwhile.
    ctx.availability.onResult((a) => {
      const line = availabilityLogLine(ctx.config, a);
      if (line.level === 'info') console.log(line.text);
      else console.warn(line.text);
    });
    ctx.availability.start();
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
