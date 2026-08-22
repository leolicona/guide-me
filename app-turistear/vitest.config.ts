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
    // BUG-036 — the suite failed on a DIFFERENT test on each full run, always with
    // `Test timed out in 5000ms`, and reproduced on checkouts carrying none of the change under
    // review. Measured rather than guessed (`vitest run --reporter=json`): the slowest tests take
    // **2.8–8.7 s** each — a screen render with MSW and TanStack Query, sometimes typing into a
    // debounced field — so the 5 s default left several of them with no headroom at all. Under
    // vitest's default file parallelism on 8 cores, whichever one loses the CPU race crosses it.
    //
    // The timeout is what was wrong, not the tests: they time out waiting for a render that does
    // arrive. Raised to a number the measurements actually fit under. If a test ever needs more
    // than this it is hung, not slow — which is the signal a timeout is for.
    testTimeout: 15_000,
  },
})
