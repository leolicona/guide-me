import { defineConfig, devices } from '@playwright/test'

// E2E walkthrough of the paid-ledger settle flow (US-LG03/LG08) against a DEPLOYED environment.
// Defaults to the dev site; override with E2E_BASE_URL. Never runs a local server — it drives a real
// browser against the remote app, so the target must already have the paid-ledger stack deployed.
const BASE_URL = process.env.E2E_BASE_URL ?? 'https://app-dev.turistearya.com'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The app is mobile-first; run the walkthrough at a phone width like a field cashier.
    viewport: { width: 414, height: 896 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
