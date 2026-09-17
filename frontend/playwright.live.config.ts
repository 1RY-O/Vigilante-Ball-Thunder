import { defineConfig } from '@playwright/test'

// Live-backend browser run: same specs, but the preview server (already
// running against the real backend on :4000) provides /api. Start it with:
//   VBT_API_PROXY=http://127.0.0.1:4000 npm run preview -- --host 127.0.0.1 --port 4173
// with the backend on :4000 (TRANSCRIPTION_ENGINE=stub for fixture results).
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:4173', headless: true },
  reporter: 'list',
})