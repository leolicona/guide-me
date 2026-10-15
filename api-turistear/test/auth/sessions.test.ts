// passkey-auth US1 (scenario 8), US5 (scenario 4), FR-020–FR-025, SC-005 — specs/004-passkey-auth.
//
// Sessions are Better Auth's database sessions behind an HttpOnly cookie signed with the
// environment secret (D5). The business middleware reads them through `auth.api.getSession` and
// keeps its contract: 401 without a session, 403 ACCOUNT_SUSPENDED for a suspended user (D6).
// Fixture sessions come from the test-only trigger (D17); counts exclude `test-session-%`.
import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTenancyDb, seedUser } from '../helpers/tenancy'
import {
  fixtureSessionToken,
  sessionCookie,
  sessionCookieFor,
  signSessionToken,
} from '../helpers/session'
import { API, AUTH, post, sessionTokenOf, withCookies } from '../helpers/auth-flows'

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'
const DAY = 24 * 60 * 60

const nowSeconds = () => Math.floor(Date.now() / 1000)

const me = (cookie: string) => SELF.fetch(`${API}/me`, { headers: { Cookie: cookie } })

const insertSession = async (
  userId: string,
  token: string,
  { expiresAt, createdAt = nowSeconds() }: { expiresAt: number; createdAt?: number },
) => {
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, token, expiresAt, createdAt, createdAt)
    .run()
}

const sessionRow = (token: string) =>
  env.DB.prepare(`SELECT token, expires_at FROM sessions WHERE token = ?`)
    .bind(token)
    .first<{ token: string; expires_at: number }>()

beforeEach(async () => {
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('passkey-auth FR-021 — only a session the API issued is honored', () => {
  it('a signed session cookie reaches a business route', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const res = await SELF.fetch(`${API}/folios`, { headers: { Cookie: sessionCookie(ADMIN_EMAIL) } })
    expect(res.status).toBe(200)
  })

  it('no cookie → 401 UNAUTHORIZED', async () => {
    const res = await SELF.fetch(`${API}/me`)
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe('UNAUTHORIZED')
  })

  it('an altered signature, another secret, an unknown token and an expired row are each refused', async () => {
    const { userId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const token = fixtureSessionToken(ADMIN_EMAIL)
    const valid = signSessionToken(token)
    const signature = decodeURIComponent(valid).slice(token.length + 1)
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)

    const altered = `__Secure-gm-test.session_token=${encodeURIComponent(`${token}.${flipped}`)}`
    const foreignSecret = sessionCookieFor(token, 'another_environment_secret_0123456789')
    const unknown = sessionCookieFor('a-token-the-api-never-issued')

    await insertSession(userId, 'expired-session-token', { expiresAt: nowSeconds() - 60 })
    const expired = sessionCookieFor('expired-session-token')

    for (const cookie of [altered, foreignSecret, unknown, expired]) {
      const res = await me(cookie)
      expect(res.status, cookie).toBe(401)
      expect(((await res.json()) as any).error.code).toBe('UNAUTHORIZED')
    }
  })

  it('a cookie from another environment (another prefix) is not even read', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const dev = sessionCookie(ADMIN_EMAIL).replace('__Secure-gm-test.', '__Secure-gm-dev.')
    expect((await me(dev)).status).toBe(401)
  })
})

describe('passkey-auth FR-025 — a suspended or deleted account is refused at its next request', () => {
  it('suspended → 403 ACCOUNT_SUSPENDED, and this device’s cookie is cleared', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', status: 'suspended', organizationId })

    const res = await me(sessionCookie(AGENT_EMAIL))
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('ACCOUNT_SUSPENDED')
    expect(res.headers.get('set-cookie')).toMatch(/__Secure-gm-test\.session_token=;.*Max-Age=0/)
  })

  it('a suspended user whose session is due for renewal is still refused (staff-management S9)', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { userId } = await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      status: 'suspended',
      organizationId,
    })
    await insertSession(userId, 'due-for-renewal', { expiresAt: nowSeconds() + 5 * DAY })

    const res = await me(sessionCookieFor('due-for-renewal'))
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('ACCOUNT_SUSPENDED')
  })

  it('a deleted user → 401 at the next request; their sessions went with them', async () => {
    const { userId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    expect((await me(sessionCookie(AGENT_EMAIL))).status).toBe(200)

    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()

    expect((await me(sessionCookie(AGENT_EMAIL))).status).toBe(401)
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>()
    expect(left?.n).toBe(0)
  })
})

describe('passkey-auth FR-022 — 7 days, renewed by use (Better Auth’s defaults)', () => {
  it('a request a day after the last renewal extends expires_at to 7 days and keeps the token', async () => {
    const { userId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await insertSession(userId, 'renew-me', {
      expiresAt: nowSeconds() + 5 * DAY,
      createdAt: nowSeconds() - 2 * DAY,
    })

    const res = await me(sessionCookieFor('renew-me'))
    expect(res.status).toBe(200)

    const row = await sessionRow('renew-me')
    expect(row?.token).toBe('renew-me')
    expect(row!.expires_at).toBeGreaterThanOrEqual(nowSeconds() + 7 * DAY - 5)
    // The renewal cookie is forwarded on the business answer, still carrying the same token.
    const renewed = withCookies('', res)
    expect(sessionTokenOf(renewed)).toBe('renew-me')
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i)
  })

  it('a session not yet due is not rewritten', async () => {
    const { userId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const expiresAt = nowSeconds() + 7 * DAY - 60
    await insertSession(userId, 'fresh-enough', { expiresAt })

    expect((await me(sessionCookieFor('fresh-enough'))).status).toBe(200)
    expect((await sessionRow('fresh-enough'))?.expires_at).toBe(expiresAt)
  })

  it('5 parallel requests during a renewal all answer 200 (BUG-014: the token never rotates)', async () => {
    const { userId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await insertSession(userId, 'parallel', { expiresAt: nowSeconds() + 5 * DAY })
    const cookie = sessionCookieFor('parallel')

    const answers = await Promise.all(Array.from({ length: 5 }, () => me(cookie)))
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    expect((await me(cookie)).status).toBe(200)
  })
})

describe('passkey-auth FR-023, FR-024 — signing out ends the session on the server', () => {
  it('POST /api/auth/sign-out → the same cookie answers 401 afterwards', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const cookie = sessionCookie(ADMIN_EMAIL)

    const out = await post('/sign-out', {}, { Cookie: cookie })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toMatch(/__Secure-gm-test\.session_token=;/)

    expect((await me(cookie)).status).toBe(401)
  })

  it('POST /api/auth/revoke-sessions ends every session of the user, another device’s included', async () => {
    const { userId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await insertSession(userId, 'other-device', { expiresAt: nowSeconds() + 6 * DAY })
    const otherDevice = sessionCookieFor('other-device')
    expect((await me(otherDevice)).status).toBe(200)

    const res = await post('/revoke-sessions', {}, { Cookie: sessionCookie(ADMIN_EMAIL) })
    expect(res.status).toBe(200)

    expect((await me(otherDevice)).status).toBe(401)
    expect((await me(sessionCookie(ADMIN_EMAIL))).status).toBe(401)
  })
})

describe('passkey-auth D2, constitution III — Better Auth never writes the tenant fields', () => {
  it('POST /api/auth/update-user cannot change organizationId, role or status', async () => {
    const { userId, organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const other = await seedUser({ email: 'otro@otra.com', role: 'admin' })

    for (const body of [
      { organizationId: other.organizationId },
      { role: 'admin' },
      { status: 'suspended' },
    ]) {
      const res = await post('/update-user', body, { Cookie: sessionCookie(AGENT_EMAIL) })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }

    const row = await env.DB.prepare('SELECT organization_id, role, status FROM users WHERE id = ?')
      .bind(userId)
      .first<{ organization_id: string; role: string; status: string }>()
    expect(row).toEqual({ organization_id: organizationId, role: 'agent', status: 'active' })
  })

  it('it can change the name only', async () => {
    const { userId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const res = await post('/update-user', { name: 'Luis Nuevo' }, { Cookie: sessionCookie(AGENT_EMAIL) })
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first()
    expect(row).toEqual({ name: 'Luis Nuevo' })
  })
})

describe('passkey-auth D2, constitution IV v1.2.1 — the session is never readable over HTTP (BFF)', () => {
  it('GET /api/auth/get-session and /api/auth/list-sessions answer 404, even signed in', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    for (const path of ['/get-session', '/list-sessions']) {
      const res = await SELF.fetch(`${AUTH}${path}`, { headers: { Cookie: sessionCookie(ADMIN_EMAIL) } })
      expect(res.status, path).toBe(404)
    }
  })

  it('the retired routes, and every password route Better Auth or its plugins bring, answer 404 (FR-060)', async () => {
    for (const path of [
      '/login',
      '/forgot-password',
      '/invite/complete',
      '/verify',
      '/sign-in/email',
      '/sign-up/email',
      '/request-password-reset',
      '/reset-password',
      '/change-password',
      '/email-otp/request-password-reset',
      '/email-otp/reset-password',
      '/forget-password/email-otp',
      '/change-email',
      '/delete-user',
    ]) {
      const res = await post(path, { email: ADMIN_EMAIL, password: 'contraseña-larga', otp: '000000' })
      expect(res.status, path).toBe(404)
    }
  })
})

describe('passkey-auth FR-020 — a cookie-bearing POST from another origin is refused (CSRF)', () => {
  it('sign-out from a foreign Origin → 403, and the session survives', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const cookie = sessionCookie(ADMIN_EMAIL)

    const res = await post('/sign-out', {}, { Cookie: cookie, Origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect((await me(cookie)).status).toBe(200)
  })
})
