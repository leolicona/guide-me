import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    // Pinned, strict ports (BUG-008): the API dev server owns 5173 (strictPort there
    // too). Without this, whichever workspace started first grabbed 5173 and the proxy
    // below could loop /api back into THIS app's own stub worker, which answered every
    // /api path with a fake 200 — login "succeeded" with any credentials.
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5173',
        changeOrigin: true,
      }
    }
  }
})