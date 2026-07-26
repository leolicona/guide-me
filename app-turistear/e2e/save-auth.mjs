// One-time session capture. Opens a real browser to app-dev's login; YOU sign in (the password
// stays in the browser). The script auto-detects the successful login (URL leaves /login) and saves
// the session COOKIES — never the password — to e2e/.auth/agent.json, then closes. Re-run any time
// the saved session expires.
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.E2E_BASE_URL ?? 'https://app-dev.turistearya.com'
// Resolve relative to THIS file (app-turistear/e2e/), so the save location never depends on cwd.
const here = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.OUT ?? resolve(here, '.auth/agent.json')
mkdirSync(dirname(OUT), { recursive: true })
console.log('Will save session to:', OUT)

const browser = await chromium.launch({ headless: false })
const context = await browser.newContext()
const page = await context.newPage()
await page.goto(`${BASE}/login`)
console.log('→ Log in in the browser window that just opened. Waiting (up to 3 min)…')
try {
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 180_000 })
  await page.waitForTimeout(1500) // let the session settle (any post-login redirect / refresh)
  await context.storageState({ path: OUT })
  console.log(`✓ Saved session to ${OUT}. You can close nothing — done.`)
} catch {
  console.error('✗ Did not detect a login within 3 minutes. Re-run and sign in fully.')
} finally {
  await browser.close()
}
