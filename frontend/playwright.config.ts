import { defineConfig } from '@playwright/test'

// Default suite uses the TEST-ONLY mock contract server (no real backend
// needed): `npm run test:e2e`. To run the same browser suite against the
// real backend instead, with the backend on :4000 and the preview proxy
// pointed at it:
//
//   VBT_API_PROXY=http://127.0.0.1:4000 npm run preview -- --host 127.0.0.1 --port 4173
//   npx playwright test -c playwright.live.config.ts
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:4173', headless: true },
  webServer: [
    { command: 'node e2e/mock-server.mjs', url: 'http://127.0.0.1:8791/api/capabilities', reuseExistingServer: false },
    { command: 'npm run preview -- --host 127.0.0.1', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
  ],
  reporter: 'list',
})
