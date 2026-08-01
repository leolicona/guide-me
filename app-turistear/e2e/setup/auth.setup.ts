import { test as setup, expect, request as pwRequest } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { env } from '../helpers'
import { AUTH_DIR, AGENT_STATE, ADMIN_STATE, API_BASE } from '../paths'

// Sign in through the API and save the resulting cookies as a Playwright storageState.
//
// This works across origins because the API sets its session cookies on `COOKIE_DOMAIN`
// (`.turistearya.com`, api-turistear/wrangler.jsonc), so a session minted at api-dev is sent to
// app-dev too. That is what lets the whole suite authenticate without driving the login form —
// the form itself is still exercised, once, by the login journey spec.
//
// Passwords come from the environment and are never written anywhere: only cookies are persisted.

async function signIn(email: string, password: string, statePath: string) {
  const ctx = await pwRequest.newContext({ baseURL: API_BASE })
  const res = await ctx.post('/api/auth/login', { data: { email, password } })

  expect(res.ok(), `login failed for ${email}: ${res.status()} ${await res.text()}`).toBeTruthy()

  const state = await ctx.storageState()
  expect(
    state.cookies.some((c) => c.name === 'gm_refresh'),
    `no gm_refresh cookie after login for ${email} — the session did not stick`,
  ).toBeTruthy()

  await ctx.storageState({ path: statePath })
  await ctx.dispose()
}

setup('authenticate the agent and the admin', async () => {
  mkdirSync(AUTH_DIR, { recursive: true })

  await signIn(env('E2E_AGENT_EMAIL'), env('E2E_AGENT_PASSWORD'), AGENT_STATE)
  await signIn(env('E2E_ADMIN_EMAIL'), env('E2E_ADMIN_PASSWORD'), ADMIN_STATE)
})
