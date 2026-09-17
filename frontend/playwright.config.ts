import { defineConfig } from '@playwright/test'
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
