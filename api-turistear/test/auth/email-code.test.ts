// passkey-auth US1 — sign in with an email code (specs/004-passkey-auth/spec.md, Story 1, scenarios
// 1–7; FR-010–FR-016, SC-010). Better Auth's emailOTP plugin with its defaults: 6 digits, 5
// minutes, 3 attempts, newest code wins; stored encrypted; sends in the background (D7). Resend is
// stood in for at its origin (constitution VI). Session counts exclude the `test-session-%`
// fixture rows (D17).
import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTenancyDb, seedUser } from '../helpers/tenancy'
import {
  API,
  clearAuthDb,
  codeIn,
  expectNoToken,
  requestCode,
  signInWithCode,
  stubResend,
  waitForEmails,
  withCookies,
  type SentEmail,
} from '../helpers/auth-flows'

const AGENT_EMAIL = 'agente@empresa.com'

let sent: SentEmail[]

const ip = (n: number) => ({ 'cf-connecting-ip': `203.0.113.${n}` })

const realSessions = async (email: string) =>
  (
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE u.email = ? AND s.token NOT LIKE 'test-session-%'`,
    )
      .bind(email)
      .first<{ n: number }>()
  )?.n ?? 0

const advance = (seconds: number) => vi.setSystemTime(new Date(Date.now() + seconds * 1000))

const codeFor = async (email: string, headers: Record<string, string> = {}) => {
  const before = sent.length
  const res = await requestCode(email, headers)
  expect(res.status).toBe(200)
  const [mail] = (await waitForEmails(sent, before + 1)).slice(before)
  expect(mail!.to).toBe(email.toLowerCase())
  return codeIn(mail!)
}

beforeEach(async () => {
  await clearTenancyDb()
  await clearAuthDb()
  sent = stubResend()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.setSystemTime(new Date('2026-06-14T12:00:00Z'))
})

describe('passkey-auth US1 — sign in with an email code', () => {
  it('scenario 1 — a known email gets a 6-digit code by email, and the code signs in', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })

    const code = await codeFor(AGENT_EMAIL)
    expect(code).toMatch(/^\d{6}$/)

    const res = await signInWithCode(AGENT_EMAIL, code)
    expect(res.status).toBe(200)
    const cookie = withCookies('', res)
    expect(cookie).toMatch(/^__Secure-gm-test\.session_token=/)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(res.headers.get('set-cookie')).toMatch(/Secure/i)

    const me = await SELF.fetch(`${API}/me`, { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect(((await me.json()) as any).user.email).toBe(AGENT_EMAIL)
  })

  it('the sign-in answer is { user } with no token anywhere (constitution IV, BFF — the shape MSW copies)', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent', name: 'Luis Agente' })
    const res = await signInWithCode(AGENT_EMAIL, await codeFor(AGENT_EMAIL))
    expect(res.status).toBe(200)

    const body = (await res.json()) as any
    expectNoToken(body)
    expect(Object.keys(body)).toEqual(['user'])
    expect(body.user).toMatchObject({
      email: AGENT_EMAIL,
      name: 'Luis Agente',
      emailVerified: true,
      role: 'agent',
      status: 'active',
    })
    expect(body.user).not.toHaveProperty('passwordHash')
  })

  it('the email states the code, that it expires in 5 minutes, and that we never ask for it (FR-014)', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const code = await codeFor(AGENT_EMAIL)
    const [mail] = sent
    expect(mail!.html).toContain(code)
    expect(mail!.html).toContain('5 minutos')
    expect(mail!.html).toContain('nunca te pedirá este código por teléfono ni WhatsApp')
  })

  it('scenario 2 — an unknown email gets the same answer and no email is sent (FR-013)', async () => {
    const res = await requestCode('nadie@ejemplo.mx')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toHaveLength(0)
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM verifications`).first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })

  it('the address is matched without regard to case (R11)', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const code = await codeFor('Agente@Empresa.COM')
    expect((await signInWithCode('AGENTE@empresa.com', code)).status).toBe(200)
  })

  it('scenario 3 — a wrong code → INVALID_OTP; the newest code wins over an older one', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const first = await codeFor(AGENT_EMAIL, ip(1))
    advance(2)
    const second = await codeFor(AGENT_EMAIL, ip(1))
    expect(second).not.toBe(first)

    const old = await signInWithCode(AGENT_EMAIL, first, ip(2))
    expect(old.status).toBe(400)
    expect(await old.json()).toEqual({ code: 'INVALID_OTP', message: 'Invalid OTP' })

    expect((await signInWithCode(AGENT_EMAIL, second, ip(3))).status).toBe(200)
  })

  it('scenario 4 — after 5 minutes the code → OTP_EXPIRED', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const code = await codeFor(AGENT_EMAIL)
    advance(301)

    const res = await signInWithCode(AGENT_EMAIL, code)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'OTP_EXPIRED', message: 'OTP expired' })
    expect(await realSessions(AGENT_EMAIL)).toBe(0)
  })

  it('scenario 5 — after 3 wrong tries even the right code → TOO_MANY_ATTEMPTS', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const code = await codeFor(AGENT_EMAIL)
    const wrong = code === '000000' ? '111111' : '000000'

    for (let i = 1; i <= 3; i++) {
      const res = await signInWithCode(AGENT_EMAIL, wrong, ip(10 + i))
      expect(res.status, `try ${i}`).toBe(400)
      expect(((await res.json()) as any).code).toBe('INVALID_OTP')
    }
    const fourth = await signInWithCode(AGENT_EMAIL, code, ip(20))
    expect(fourth.status).toBe(403)
    expect(await fourth.json()).toEqual({ code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' })
    expect(await realSessions(AGENT_EMAIL)).toBe(0)
  })

  it('a code is single use', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const code = await codeFor(AGENT_EMAIL)
    expect((await signInWithCode(AGENT_EMAIL, code, ip(1))).status).toBe(200)
    const again = await signInWithCode(AGENT_EMAIL, code, ip(2))
    expect(again.status).toBe(400)
    expect(((await again.json()) as any).code).toBe('INVALID_OTP')
  })

  it('scenario 6 — an unverified account becomes active with its address verified (FR-015)', async () => {
    const { userId } = await seedUser({ email: AGENT_EMAIL, role: 'admin', status: 'unverified' })
    const res = await signInWithCode(AGENT_EMAIL, await codeFor(AGENT_EMAIL))
    expect(res.status).toBe(200)

    const row = await env.DB.prepare('SELECT status, email_verified FROM users WHERE id = ?')
      .bind(userId)
      .first()
    expect(row).toEqual({ status: 'active', email_verified: 1 })
  })

  it('scenario 7 — a suspended account → 403 ACCOUNT_SUSPENDED and no session is written', async () => {
    const { organizationId } = await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', status: 'suspended', organizationId })

    const res = await signInWithCode(AGENT_EMAIL, await codeFor(AGENT_EMAIL))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'ACCOUNT_SUSPENDED', message: 'Account suspended' })
    expect(res.headers.getSetCookie().some((c) => /session_token=[^;]/.test(c))).toBe(false)
    expect(await realSessions(AGENT_EMAIL)).toBe(0)
  })

  it('FR-016 — the stored value is not the code', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const code = await codeFor(AGENT_EMAIL)
    const row = await env.DB.prepare(`SELECT identifier, value FROM verifications`).first<{
      identifier: string
      value: string
    }>()
    expect(row?.identifier).toBe(`sign-in-otp-${AGENT_EMAIL}`)
    expect(row!.value).not.toContain(code)
  })
})

describe('passkey-auth FR-012 — Better Auth’s rate limits, per client IP, answer 429 with X-Retry-After', () => {
  it('the 4th code request within 60 s from one address → 429', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    for (let i = 0; i < 3; i++) expect((await requestCode(AGENT_EMAIL, ip(7))).status).toBe(200)

    const fourth = await requestCode(AGENT_EMAIL, ip(7))
    expect(fourth.status).toBe(429)
    expect(Number(fourth.headers.get('X-Retry-After'))).toBeGreaterThan(0)
    expect(await fourth.json()).toEqual({ message: 'Too many requests. Please try again later.' })

    // Another address is not held back by this one.
    expect((await requestCode(AGENT_EMAIL, ip(8))).status).toBe(200)
  })

  it('the 4th sign-in attempt within 60 s from one address → 429 (the emailOTP plugin’s own rule)', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await codeFor(AGENT_EMAIL)
    for (let i = 0; i < 3; i++) {
      expect((await signInWithCode(AGENT_EMAIL, '000001', ip(9))).status).not.toBe(429)
    }
    const fourth = await signInWithCode(AGENT_EMAIL, '000001', ip(9))
    expect(fourth.status).toBe(429)
    expect(Number(fourth.headers.get('X-Retry-After'))).toBeGreaterThan(0)
  })

  it('the limit is CORS-exposed so the app can count down "Reenviar código" (D9)', async () => {
    const res = await SELF.fetch(`${API}/auth/email-otp/send-verification-otp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.turistearya.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    const get = await SELF.fetch(`${API}/me`, { headers: { Origin: 'https://app.turistearya.com' } })
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(get.headers.get('access-control-expose-headers')).toMatch(/X-Retry-After/i)
  })
})
