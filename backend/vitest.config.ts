import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Subprocess-heavy tests (real python fake worker) need real timers and
    // generous timeouts; the suite remains fast because work is tiny.
    testTimeout: 30_000,
    hookTimeout: 20_000,
    // Jobs/timers hold handles; don't let one leaking test hang the suite.
    teardownTimeout: 5_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
