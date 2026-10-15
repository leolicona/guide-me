import { test as setup, expect, type Browser } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { env } from '../helpers'
import { AUTH_DIR, AGENT_STATE, ADMIN_STATE, BASE_URL } from '../paths'
import { addVirtualAuthenticator, loadPasskey, parsePasskeySecret } from '../passkey'

// Sign each account in through the browser with its llave de acceso, and save the session cookie
// as a Playwright storageState (passkey-auth D17, R13).
//
// The llave lives in Chrome's virtual authenticator, loaded from the E2E_*_PASSKEY secret that
// `e2e/enroll-passkey.ts` produced. The ceremony is the real one: "Entrar con llave de acceso" on
// the deployed app, verified by the deployed API.
//
// This works across origins because Better Auth sets its session cookie on `COOKIE_DOMAIN`
// (`.turistearya.com`, api-turistear/wrangler.jsonc), so the session the app's sign-in got from
// api-dev is sent to api-dev by the seed's API calls and by the journeys' pages alike.
//
// Private keys come from the environment and are never written anywhere: only cookies are persisted.

const PASSKEY_BUTTON = 'Entrar con llave de acceso'

async function signIn(browser: Browser, secretName: string, statePath: string) {
  const secret = parsePasskeySecret(secretName, env(secretName))
  const context = await browser.newContext({ baseURL: BASE_URL })
  try {
    const page = await context.newPage()
    const { cdp, authenticatorId } = await addVirtualAuthenticator(context, page)
    await loadPasskey(cdp, authenticatorId, secret)

    await page.goto('/login')
    // Conditional UI may already answer from the email field's autofill and navigate away; then
    // the button is gone, and the URL check below is what decides.
    await page
      .getByRole('button', { name: PASSKEY_BUTTON })
      .click({ timeout: 15_000 })
      .catch(() => {})

    await expect(page, `${secretName}: the llave de acceso did not sign in`).not.toHaveURL(
      /\/login/,
      { timeout: 30_000 },
    )

    const state = await context.storageState({ path: statePath })
    expect(
      state.cookies.some((c) => c.name.endsWith('.session_token')),
      `no session cookie after signing in with ${secretName} — the session did not stick`,
    ).toBeTruthy()
  } finally {
    await context.close()
  }
}

setup('sign the agent and the admin in with their llaves de acceso', async ({ browser }) => {
  mkdirSync(AUTH_DIR, { recursive: true })

  await signIn(browser, 'E2E_AGENT_PASSKEY', AGENT_STATE)
  await signIn(browser, 'E2E_ADMIN_PASSKEY', ADMIN_STATE)
})
