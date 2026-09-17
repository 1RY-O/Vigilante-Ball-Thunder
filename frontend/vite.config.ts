import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Production uses the real backend (backend/src); the Vite dev/preview
// server proxies /api to it (override with VBT_API_PROXY; e2e uses 8791).
const target = process.env.VBT_API_PROXY ?? 'http://127.0.0.1:8791'
export default defineConfig({
  plugins: [react()],
  // e2e/mock-server.mjs is a TEST-ONLY stand-in; never a production source.
  server: { proxy: { '/api': target } },
  preview: { proxy: { '/api': target } },
})
