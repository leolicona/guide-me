// passkey-auth US3 — a new admin registers without a password (specs/004-passkey-auth/spec.md,
// Story 3, scenarios 1–4; FR-030; D10). POST /api/onboarding/register writes the organization with
// its cancellation policy and an `unverified` admin, then sends a sign-in code through Better
// Auth's emailOTP plugin; redeeming it verifies the address and signs the admin in. Replaces the
// withdrawn test/auth/admin-registration.test.ts (research.md § Withdrawn scenarios). Session
// counts exclude the `test-session-%` fixture rows (D17).
import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTenancyDb, seedUser } from '../helpers/tenancy'
import {
  API,
  clearAuthDb,
  codeIn,
  signInWithCode,
  stubResend,
  waitForEmails,
  withCookies,
  type SentEmail,
} from '../helpers/auth-flows'

const BODY = {
  name: 'Ana Admin',
  email: 'ana@ejemplo.mx',
  company_name: 'Tours Ana',
  phone: '+52 55 1111 2222',
}

let sent: SentEmail[]

const register = (body: unknown) =>
  SELF.fetch(`${API}/onboarding/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const realSessions = async (email: string) =>
  (
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE u.email = ? AND s.token NOT LIKE 'test-session-%'`,
    )
      .bind(email)
      .first<{ n: number }>()
  )?.n ?? 0

beforeEach(async () => {
  await clearTenancyDb()
  await clearAuthDb()
  sent = stubResend()
})
afterEach(() => vi.restoreAllMocks())

describe('passkey-auth US3 — register an organization without a password', () => {
  it('scenario 1 — name, email, company and phone are enough: 201, an unverified admin, a code sent', async () => {
    const res = await register(BODY)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ message: 'Te enviamos un código a tu correo.' })

    const user = await env.DB.prepare(
      `SELECT u.name, u.role, u.status, u.email_verified, u.phone, o.name AS org
       FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.email = ?`,
    )
      .bind(BODY.email)
      .first()
    expect(user).toEqual({
      name: 'Ana Admin',
      role: 'admin',
      status: 'unverified',
      email_verified: 0,
      phone: BODY.phone,
      org: 'Tours Ana',
    })

    const [mail] = await waitForEmails(sent, 1)
    expect(mail!.to).toBe(BODY.email)
    expect(codeIn(mail!)).toMatch(/^\d{6}$/)
    expect(await realSessions(BODY.email)).toBe(0)
  })

  it('scenario 2 — the code signs the admin in, verified and active, in their new organization', async () => {
    await register(BODY)
    const [mail] = await waitForEmails(sent, 1)

    const res = await signInWithCode(BODY.email, codeIn(mail!))
    expect(res.status).toBe(200)

    const me = await SELF.fetch(`${API}/me`, { headers: { Cookie: withCookies('', res) } })
    expect(me.status).toBe(200)
    expect(((await me.json()) as any).user).toMatchObject({ email: BODY.email, role: 'admin' })

    const row = await env.DB.prepare('SELECT status, email_verified FROM users WHERE email = ?')
      .bind(BODY.email)
      .first()
    expect(row).toEqual({ status: 'active', email_verified: 1 })
  })

  it('scenario 3 — the organization is born with its cancellation policy (D17)', async () => {
    await register(BODY)
    const org = await env.DB.prepare(
      `SELECT o.cancellation_policy FROM organizations o JOIN users u ON u.organization_id = o.id
       WHERE u.email = ?`,
    )
      .bind(BODY.email)
      .first<{ cancellation_policy: string | null }>()
    expect(org?.cancellation_policy).toBeTruthy()
    expect(JSON.parse(org!.cancellation_policy!)).toBeTypeOf('object')
  })

  it('scenario 4 — an email already registered → 409 EMAIL_ALREADY_EXISTS, nothing written or sent', async () => {
    await seedUser({ email: BODY.email, role: 'admin' })
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM organizations').first<{ n: number }>()

    const res = await register({ ...BODY, email: 'ANA@Ejemplo.mx' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('EMAIL_ALREADY_EXISTS')

    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM organizations').first<{ n: number }>()
    expect(after?.n).toBe(before?.n)
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toHaveLength(0)
  })

  it('a mixed-case email is stored lowercased (R11)', async () => {
    await register({ ...BODY, email: '  Ana@Ejemplo.MX ' })
    const row = await env.DB.prepare('SELECT email FROM users').first()
    expect(row).toEqual({ email: 'ana@ejemplo.mx' })
  })

  it('a password is never needed, and a missing field → 400 VALIDATION_ERROR', async () => {
    for (const missing of ['name', 'email', 'company_name', 'phone'] as const) {
      const { [missing]: _drop, ...partial } = BODY
      const res = await register(partial)
      expect(res.status, missing).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    }
  })
})
