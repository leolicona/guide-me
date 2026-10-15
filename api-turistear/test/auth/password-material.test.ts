// passkey-auth D15, debt `password-material` — migration 0072 drops `users.password_hash`,
// `users.password_salt` and `password_reset_tokens`. A migration runs before the code it ships with
// and must be backward-compatible with the code already deployed (constitution, Additional
// constraints), so this file drops them from its own database first: every request below proves
// the code works without them. The rest of the suite, which still has them, proves it works before
// the drop.
//
// What the drop breaks first is a new user: an insert that names a dropped column fails. Reads do
// not fail: SQLite takes a double-quoted name it cannot resolve for a string literal, so a mapped
// but dropped column reads back as the text 'password_hash'. `users` (db/schema.ts) maps neither
// column, so no read leans on that. Migration 0072 deletes this file: from then on the whole suite
// runs without them.
import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTenancyDb } from '../helpers/tenancy'
import { sessionCookie } from '../helpers/session'
import {
  API,
  clearAuthDb,
  codeIn,
  post,
  registerPasskey,
  signInByEmail,
  signInWithCode,
  signInWithPasskey,
  stubResend,
  waitForEmails,
  withCookies,
  type SentEmail,
} from '../helpers/auth-flows'

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agente@empresa.com'

let sent: SentEmail[]
let organizationId: string

const me = (cookie: string) => SELF.fetch(`${API}/me`, { headers: { Cookie: cookie } })

const onboarding = (path: string, body: unknown) =>
  SELF.fetch(`${API}/onboarding${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const userRow = (email: string) =>
  env.DB.prepare('SELECT role, status, email_verified FROM users WHERE email = ?')
    .bind(email)
    .first()

// seedUser (test/helpers/tenancy.ts) writes the password columns; this database has none.
const seed = async () => {
  organizationId = crypto.randomUUID()
  await env.DB.prepare('INSERT INTO organizations (id, name, timezone) VALUES (?, ?, ?)')
    .bind(organizationId, 'Empresa S.A.', 'UTC')
    .run()
  for (const [email, role, status] of [
    [ADMIN_EMAIL, 'admin', 'unverified'],
    [AGENT_EMAIL, 'agent', 'active'],
  ] as const) {
    await env.DB.prepare(
      'INSERT INTO users (id, organization_id, name, email, role, status) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(crypto.randomUUID(), organizationId, 'Test User', email, role, status)
      .run()
  }
}

beforeAll(async () => {
  await env.DB.exec('DROP TABLE password_reset_tokens')
  await env.DB.exec('ALTER TABLE users DROP COLUMN password_hash')
  await env.DB.exec('ALTER TABLE users DROP COLUMN password_salt')
})

beforeEach(async () => {
  await clearTenancyDb()
  await clearAuthDb()
  sent = stubResend()
  await seed()
})
afterEach(() => vi.restoreAllMocks())

describe('passkey-auth D15 — the code works after migration 0072', () => {
  it('this database has neither the columns nor the table', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('users') WHERE name LIKE 'password%'
       UNION ALL SELECT name FROM sqlite_master WHERE name = 'password_reset_tokens'`,
    ).all()
    expect(results).toEqual([])
  })

  it('an organization registers, and its admin signs in by code', async () => {
    const res = await onboarding('/register', {
      name: 'Ana Admin',
      email: 'Ana@Ejemplo.mx',
      company_name: 'Tours Ana',
      phone: '+52 55 1111 2222',
    })
    expect(res.status).toBe(201)
    expect(await userRow('ana@ejemplo.mx')).toEqual({
      role: 'admin',
      status: 'unverified',
      email_verified: 0,
    })

    const [mail] = await waitForEmails(sent, 1)
    const signedIn = await signInWithCode('ana@ejemplo.mx', codeIn(mail!))
    expect(signedIn.status).toBe(200)
    const cookie = withCookies('', signedIn)
    expect(((await (await me(cookie)).json()) as any).user.email).toBe('ana@ejemplo.mx')
  })

  it('the same email registering again is still refused', async () => {
    const res = await onboarding('/register', {
      name: 'Otra',
      email: ADMIN_EMAIL,
      company_name: 'Otra S.A.',
      phone: '+52 55 1111 2222',
    })
    expect(res.status).toBe(409)
  })

  it('an invited agent accepts and is written active and verified', async () => {
    await env.DB.prepare(
      `INSERT INTO invitations (id, organization_id, identity, identity_type, token, invited_by, status, expires_at)
       VALUES (?, ?, 'nuevo@empresa.com', 'email', 'invite_token_abc', ?, 'pending', ?)`,
    )
      .bind(
        crypto.randomUUID(),
        organizationId,
        (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(ADMIN_EMAIL).first<{
          id: string
        }>())!.id,
        Math.floor(Date.now() / 1000) + 3600,
      )
      .run()

    const res = await onboarding('/invitations/invite_token_abc/accept', { name: 'Nuevo Agente' })
    expect(res.status).toBe(200)
    expect(await userRow('nuevo@empresa.com')).toEqual({
      role: 'agent',
      status: 'active',
      email_verified: 1,
    })
    const invitation = await env.DB.prepare('SELECT status FROM invitations').first()
    expect(invitation).toEqual({ status: 'accepted' })
  })

  it('an email code signs an unverified admin in, makes them active, and the session reads them', async () => {
    const cookie = await signInByEmail(sent, ADMIN_EMAIL)
    const res = await me(cookie)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).user).toMatchObject({ email: ADMIN_EMAIL, role: 'admin' })
    expect(await userRow(ADMIN_EMAIL)).toEqual({ role: 'admin', status: 'active', email_verified: 1 })
  })

  it('a llave de acceso registers, and signs in', async () => {
    const { res, credential } = await registerPasskey(sessionCookie(AGENT_EMAIL), {
      name: 'Mi teléfono',
    })
    expect(res.status).toBe(200)

    const signedIn = await signInWithPasskey(credential!)
    expect(signedIn.res.status).toBe(200)
    expect(((await (await me(signedIn.cookie)).json()) as any).user.email).toBe(AGENT_EMAIL)
  })

  it('the user changes their name through Better Auth', async () => {
    const res = await post(
      '/update-user',
      { name: 'Nuevo Nombre' },
      { Cookie: sessionCookie(AGENT_EMAIL) },
    )
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT name FROM users WHERE email = ?')
      .bind(AGENT_EMAIL)
      .first()
    expect(row).toEqual({ name: 'Nuevo Nombre' })
  })

  it('an admin lists the agents', async () => {
    const res = await SELF.fetch(`${API}/agents`, {
      headers: { Cookie: sessionCookie(ADMIN_EMAIL) },
    })
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toContain(AGENT_EMAIL)
  })
})
