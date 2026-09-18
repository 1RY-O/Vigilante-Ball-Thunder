import { buildContext } from './appContext.js';
import { createApp } from './app.js';

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
    void ctx.engine
      .available()
      .then((a) => {
        if (a.ok) console.log('MuScriptor engine: ready (deps installed, HF access verified).');
        else console.warn(`MuScriptor engine NOT available: ${a.reason ?? a.code ?? 'unknown reason'}`);
      })
      .catch(() => console.warn('MuScriptor engine availability check failed.'));
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
