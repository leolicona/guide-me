import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'
import ssrPlugin from 'vite-ssr-components/plugin'

export default defineConfig({
  plugins: [cloudflare(), ssrPlugin()],
  // The app's dev proxy targets this port (app-turistear/vite.config.ts). strictPort makes
  // a port collision fail loudly instead of silently shifting the API to 5174 — which
  // left the app proxying /api to ITSELF and its stub worker faking 200s (BUG-008).
  server: {
    port: 5173,
    strictPort: true,
  },
})
