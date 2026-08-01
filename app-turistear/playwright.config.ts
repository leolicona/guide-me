import { defineConfig, devices } from '@playwright/test'
import { AGENT_STATE, BASE_URL } from './e2e/paths'

// E2E journeys against a DEPLOYED environment (defaults to dev; override with E2E_BASE_URL).
//
// The suite seeds its OWN data: `auth` signs in through the API and saves cookies, `seed` creates
// the apartado the journeys need, and `cleanup` cancels it afterwards. Nothing here waits on a
// human to make a booking and paste its id — a suite that needs that has never gated anything.
//
// Not part of the `verify` merge gate (docs/TESTING.md D7): it needs a real browser and a deployed
// target. It runs nightly and on demand — see .github/workflows/e2e.yml.
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  // The seeded apartado is shared mutable state (one balance, settled once), so journeys that
  // touch it must not race each other.
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The app is mobile-first; run the journeys at a phone width like a field cashier.
    viewport: { width: 414, height: 896 },
  },
  projects: [
    { name: 'auth', testMatch: /setup\/auth\.setup\.ts/ },
    { name: 'seed', testMatch: /setup\/seed\.setup\.ts/, dependencies: ['auth'] },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: AGENT_STATE },
      dependencies: ['seed'],
      teardown: 'cleanup',
      testIgnore: [/setup\//, /teardown\//],
    },
    { name: 'cleanup', testMatch: /teardown\/cleanup\.teardown\.ts/ },
  ],
})
