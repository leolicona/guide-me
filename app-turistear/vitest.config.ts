import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// A SEPARATE config from vite.config.ts on purpose (docs/TESTING.md D3): vite.config.ts loads
// @cloudflare/vite-plugin, which boots a Worker runtime. Component tests run in jsdom and must not.
// Only the React plugin is needed here — JSX transform and nothing else.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Globals off (docs/TESTING.md § Conventions): tests import describe/it/expect explicitly, so
    // tsc type-checks the same identifiers Vitest injects. The cost is that Testing Library's
    // automatic cleanup does not self-register — src/test/setup.ts calls it.
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    restoreMocks: true,
  },
})
