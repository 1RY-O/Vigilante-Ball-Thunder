import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // e2e/mock-server.mjs is a TEST-ONLY stand-in implementing BACKEND_CONTRACT.md.
  // Production must use the real backend; nothing here is a data source for the app.
  server: { proxy: { '/api': 'http://127.0.0.1:8791' } },
  preview: { proxy: { '/api': 'http://127.0.0.1:8791' } },
})
