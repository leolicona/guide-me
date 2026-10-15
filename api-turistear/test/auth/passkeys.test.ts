// passkey-auth US2 — create a llave de acceso and sign in with it (specs/004-passkey-auth/spec.md,
// Story 2; FR-001–FR-006). Real ceremonies against the passkey plugin, driven by the software
// authenticator in test/helpers/authenticator.ts (D17, R13). Fixture sessions (D17) are fresh:
// the trigger stamps them with real time, which the frozen test clock reads as just now or later.
import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTenancyDb, seedUser } from '../helpers/tenancy'
import { sessionCookie, sessionCookieFor } from '../helpers/session'
import {
  API,
  AUTH,
  clearAuthDb,
  expectNoToken,
  post,
  registerPasskey,
  signInWithPasskey,
  stubResend,
  withCookies,
} from '../helpers/auth-flows'

const AGENT_EMAIL = 'agente@empresa.com'
const DAY = 24 * 60 * 60

const me = (cookie: string) => SELF.fetch(`${API}/me`, { headers: { Cookie: cookie } })

const realSessions = async (userId: string) =>
  (
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND token NOT LIKE 'test-session-%'`,
    )
      .bind(userId)
      .first<{ n: number }>()
  )?.n ?? 0

// An agent with one llave de acceso, registered on their fixture session.
const agentWithPasskey = async (opts: { counter?: number } = {}) => {
  const seeded = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
  const { res, credential } = await registerPasskey(sessionCookie(AGENT_EMAIL), {
    name: 'Mi teléfono',
    counter: opts.counter,
  })
  expect(res.status).toBe(200)
  return { ...seeded, credential: credential! }
}

beforeEach(async () => {
  await clearTenancyDb()
  await clearAuthDb()
  stubResend()
})
afterEach(() => vi.restoreAllMocks())

describe('passkey-auth US2 — create a llave de acceso', () => {
  it('the registration options bind it to this environment and require a discoverable, verified key', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const res = await SELF.fetch(`${AUTH}/passkey/generate-register-options`, {
      headers: { Cookie: sessionCookie(AGENT_EMAIL) },
    })
    expect(res.status).toBe(200)
    const options = (await res.json()) as any
    expect(options.challenge).toEqual(expect.any(String))
    expect(options.rp).toEqual({ name: 'Turistear Ya!', id: new URL(env.APP_BASE_URL).hostname })
    // The device lists the account by its email.
    expect(options.user).toMatchObject({ name: AGENT_EMAIL, displayName: AGENT_EMAIL })
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })
  })

  it('scenario 1 — a session less than a day old registers one (200, the passkey, a notice)', async () => {
    const sent = stubResend()
    const { userId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { res } = await registerPasskey(sessionCookie(AGENT_EMAIL), { name: 'Mi teléfono' })
    expect(res.status).toBe(200)

    const body = (await res.json()) as any
    expectNoToken(body)
    expect(body).toMatchObject({
      name: 'Mi teléfono',
      userId,
      deviceType: 'multiDevice',
      backedUp: true,
    })
    const row = await env.DB.prepare('SELECT user_id, name FROM passkeys').first()
    expect(row).toEqual({ user_id: userId, name: 'Mi teléfono' })

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.to).toBe(AGENT_EMAIL)
    expect(sent[0]!.subject).toMatch(/Se agregó una llave de acceso/)
  })

  it('scenario 9 — a session older than a day → 403 SESSION_NOT_FRESH (FR-005)', async () => {
    const { userId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, 'stale', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), userId, now + 6 * DAY, now - 2 * DAY, now - DAY)
      .run()

    const res = await SELF.fetch(`${AUTH}/passkey/generate-register-options`, {
      headers: { Cookie: sessionCookieFor('stale') },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'SESSION_NOT_FRESH', message: 'Session is not fresh' })
  })

  it('without a session nothing can be registered', async () => {
    const res = await SELF.fetch(`${AUTH}/passkey/generate-register-options`)
    expect(res.status).toBe(401)
  })

  it('asking for a session on the registration answer still carries no token (BFF)', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const cookie = sessionCookie(AGENT_EMAIL)
    const optionsRes = await SELF.fetch(`${AUTH}/passkey/generate-register-options`, {
      headers: { Cookie: cookie },
    })
    const options = (await optionsRes.json()) as any
    const { createCredential } = await import('../helpers/authenticator')
    const { response } = await createCredential(options, { origin: env.APP_BASE_URL })
    const res = await post(
      '/passkey/verify-registration',
      { response, createSession: true },
      { Cookie: withCookies(cookie, optionsRes) },
    )
    expect(res.status).toBe(200)
    expectNoToken(await res.json())
  })
})

describe('passkey-auth US2 — sign in with a llave de acceso', () => {
  it('scenario 2 — a discoverable sign-in, with no email, gets a session cookie', async () => {
    const { credential } = await agentWithPasskey()
    const { res, cookie } = await signInWithPasskey(credential)
    expect(res.status).toBe(200)
    expect(cookie).toMatch(/^__Secure-gm-test\.session_token=/)

    const who = await me(cookie)
    expect(who.status).toBe(200)
    expect(((await who.json()) as any).user.email).toBe(AGENT_EMAIL)
  })

  it('the options and the answer have the shapes MSW copies; no token anywhere (BFF)', async () => {
    const { credential } = await agentWithPasskey()
    const { res, options } = await signInWithPasskey(credential)
    expect(options).toMatchObject({
      challenge: expect.any(String),
      rpId: new URL(env.APP_BASE_URL).hostname,
      userVerification: 'preferred',
    })
    const body = (await res.json()) as any
    expectNoToken(body)
    expect(Object.keys(body).sort()).toEqual(['session', 'user'])
    expect(body.user).toMatchObject({ email: AGENT_EMAIL, role: 'agent' })
    expect(body.session).toMatchObject({ userId: body.user.id })
  })

  it('scenario 5 — a removed llave de acceso → 401 PASSKEY_NOT_FOUND', async () => {
    const { credential } = await agentWithPasskey()
    await env.DB.exec('DELETE FROM passkeys')

    const { res } = await signInWithPasskey(credential)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'PASSKEY_NOT_FOUND', message: 'Passkey not found' })
  })

  it('FR-006 — a use count behind the server’s (a cloned key) is refused', async () => {
    const { credential, userId } = await agentWithPasskey({ counter: 5 })

    const lowered = await signInWithPasskey(credential, { counter: 3 })
    expect(lowered.res.status).toBe(400)
    expect(((await lowered.res.json()) as any).code).toBe('AUTHENTICATION_FAILED')

    expect((await signInWithPasskey(credential, { counter: 6 })).res.status).toBe(200)
    const replayed = await signInWithPasskey(credential, { counter: 6 })
    expect(replayed.res.status).toBe(400)
    expect(await realSessions(userId)).toBe(1)
  })

  it('FR-003 — an assertion made for another origin or another rpID is refused', async () => {
    const { credential, userId } = await agentWithPasskey()

    const otherOrigin = await signInWithPasskey(credential, { origin: 'https://app-dev.turistearya.com' })
    expect(otherOrigin.res.status).toBe(400)
    expect(((await otherOrigin.res.json()) as any).code).toBe('AUTHENTICATION_FAILED')

    const otherRp = await signInWithPasskey(credential, { rpId: 'app-dev.turistearya.com' })
    expect(otherRp.res.status).toBe(400)
    expect(((await otherRp.res.json()) as any).code).toBe('AUTHENTICATION_FAILED')

    expect(await realSessions(userId)).toBe(0)
  })

  it('a credential registered for another environment’s origin is never stored', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { res } = await registerPasskey(sessionCookie(AGENT_EMAIL), {
      origin: 'https://app-dev.turistearya.com',
    })
    // Better Auth answers a registration that does not verify with a 500 of its own.
    expect(res.status).toBe(500)
    expect(((await res.json()) as any).code).toBe('FAILED_TO_VERIFY_REGISTRATION')
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys').first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })

  it('a verification without its challenge → 400 CHALLENGE_NOT_FOUND', async () => {
    const { credential } = await agentWithPasskey()
    const optionsRes = await SELF.fetch(`${AUTH}/passkey/generate-authenticate-options`)
    const options = (await optionsRes.json()) as any
    const { getAssertion } = await import('../helpers/authenticator')
    const response = await getAssertion(options, credential, { origin: env.APP_BASE_URL })
    const res = await post('/passkey/verify-authentication', { response })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).code).toBe('CHALLENGE_NOT_FOUND')
  })

  it('FR-006 — a suspended owner → 403 ACCOUNT_SUSPENDED and no session is written', async () => {
    const { credential, userId } = await agentWithPasskey()
    await env.DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).bind(userId).run()

    const { res } = await signInWithPasskey(credential)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'ACCOUNT_SUSPENDED', message: 'Account suspended' })
    expect(await realSessions(userId)).toBe(0)
  })
})
