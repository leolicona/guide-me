// passkey-auth US4 — an invited agent joins without a password (specs/004-passkey-auth/spec.md,
// Story 4, scenarios 1–4; FR-031; D11). It restates the old test/auth/agent-invitation.test.ts
// scenarios 1, 3–8 and the BUG-011 regression on Better Auth sessions (the invite itself is
// unchanged; the lookup moved to /api/onboarding), and replaces its scenarios 9–11 (research.md §
// Withdrawn scenarios). Session counts exclude the `test-session-%` fixture rows (D17).
import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTenancyDb, seedUser } from '../helpers/tenancy'
import { sessionCookie } from '../helpers/session'
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

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agente@empresa.com'
const ORG_NAME = 'Empresa S.A.'

let sent: SentEmail[]

const seedInvitation = async ({
  organizationId,
  invitedBy,
  identity = AGENT_EMAIL,
  token = 'invite_token_abc',
  status = 'pending',
  expiresInSeconds = 60 * 60 * 24 * 7,
}: {
  organizationId: string
  invitedBy: string
  identity?: string
  token?: string
  status?: 'pending' | 'accepted' | 'expired'
  expiresInSeconds?: number
}) => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO invitations (id, organization_id, identity, identity_type, token, invited_by, status, expires_at)
     VALUES (?, ?, ?, 'email', ?, ?, ?, ?)`,
  )
    .bind(id, organizationId, identity, token, invitedBy, status, Math.floor(Date.now() / 1000) + expiresInSeconds)
    .run()
  return { id, token }
}

const invite = (cookie: string | null, identity: string) =>
  SELF.fetch(`${API}/agents/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ identity }),
  })

const lookup = (token: string) => SELF.fetch(`${API}/onboarding/invitations/${token}`)

const accept = (token: string, body: unknown) =>
  SELF.fetch(`${API}/onboarding/invitations/${token}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const invitationCount = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS c FROM invitations').first<{ c: number }>())?.c

beforeEach(async () => {
  await clearTenancyDb()
  await clearAuthDb()
  sent = stubResend()
})
afterEach(() => vi.restoreAllMocks())

describe('Agent invitation — POST /api/agents/invite (unchanged; restated on Better Auth sessions)', () => {
  it('scenario 1 — an admin invites an agent: a pending 7-day invitation and an email with the link', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const res = await invite(sessionCookie(ADMIN_EMAIL), AGENT_EMAIL)
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).message).toBe('Invitación enviada.')

    const row = await env.DB.prepare(
      'SELECT identity, identity_type, status, organization_id, invited_by, token, expires_at FROM invitations',
    ).first<any>()
    expect(row).toMatchObject({
      identity: AGENT_EMAIL,
      identity_type: 'email',
      status: 'pending',
      organization_id: admin.organizationId,
      invited_by: admin.userId,
    })
    const now = Math.floor(Date.now() / 1000)
    const week = 60 * 60 * 24 * 7
    expect(row.expires_at).toBeGreaterThan(now + week - 60)
    expect(row.expires_at).toBeLessThan(now + week + 60)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(AGENT_EMAIL)
    expect(sent[0]!.html).toContain(`/invite/accept?token=${row.token}`)
  })

  it('the invited address is stored lowercased (R11)', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    expect((await invite(sessionCookie(ADMIN_EMAIL), 'Agente@Empresa.COM')).status).toBe(201)
    const row = await env.DB.prepare('SELECT identity FROM invitations').first()
    expect(row).toEqual({ identity: AGENT_EMAIL })
  })

  it('scenario 3 — no session → 401 UNAUTHORIZED, nothing written or sent', async () => {
    const res = await invite(null, AGENT_EMAIL)
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe('UNAUTHORIZED')
    expect(await invitationCount()).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('scenario 4 — an agent → 403 FORBIDDEN, nothing written or sent', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'agent' })
    const res = await invite(sessionCookie(ADMIN_EMAIL), AGENT_EMAIL)
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('FORBIDDEN')
    expect(await invitationCount()).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('scenario 5 — an address that already has an account → 409 IDENTITY_ALREADY_EXISTS', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: admin.organizationId })
    const res = await invite(sessionCookie(ADMIN_EMAIL), AGENT_EMAIL)
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('IDENTITY_ALREADY_EXISTS')
    expect(await invitationCount()).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('scenario 6 — a new invitation expires the previous pending one', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const previous = await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      token: 'old_token',
    })
    expect((await invite(sessionCookie(ADMIN_EMAIL), AGENT_EMAIL)).status).toBe(201)

    const old = await env.DB.prepare('SELECT status FROM invitations WHERE id = ?').bind(previous.id).first()
    expect(old).toEqual({ status: 'expired' })
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM invitations WHERE identity = ? AND status = 'pending'",
    )
      .bind(AGENT_EMAIL)
      .first<{ c: number }>()
    expect(pending?.c).toBe(1)
  })

  it("BUG-011 — inviting an address never expires ANOTHER organization's pending invitation", async () => {
    const orgA = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const orgB = await seedUser({ email: 'admin-b@otra.com', role: 'admin' })
    const inviteA = await seedInvitation({
      organizationId: orgA.organizationId,
      invitedBy: orgA.userId,
      token: 'org_a_token',
    })
    expect((await invite(sessionCookie('admin-b@otra.com'), AGENT_EMAIL)).status).toBe(201)

    const rowA = await env.DB.prepare('SELECT status FROM invitations WHERE id = ?').bind(inviteA.id).first()
    expect(rowA).toEqual({ status: 'pending' })
    const rowB = await env.DB.prepare(
      "SELECT status FROM invitations WHERE organization_id = ? AND identity = ? AND status = 'pending'",
    )
      .bind(orgB.organizationId, AGENT_EMAIL)
      .first()
    expect(rowB).toEqual({ status: 'pending' })
  })
})

describe('passkey-auth US4 — GET /api/onboarding/invitations/:token', () => {
  it('scenario 7 — a valid pending token answers its details, sets no cookie and changes nothing', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin', organizationName: ORG_NAME })
    await seedInvitation({ organizationId: admin.organizationId, invitedBy: admin.userId, token: 'valid_token' })

    const res = await lookup('valid_token')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      invitation: { identity: AGENT_EMAIL, identity_type: 'email', organization_name: ORG_NAME },
    })
    expect(res.headers.getSetCookie()).toHaveLength(0)
    const row = await env.DB.prepare('SELECT status FROM invitations').first()
    expect(row).toEqual({ status: 'pending' })
  })

  it('scenario 8 — an expired or unknown token → 400 INVALID_TOKEN', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      token: 'expired_token',
      expiresInSeconds: -60,
    })
    for (const token of ['expired_token', 'does_not_exist']) {
      const res = await lookup(token)
      expect(res.status, token).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('INVALID_TOKEN')
    }
  })
})

describe('passkey-auth US4 — POST /api/onboarding/invitations/:token/accept', () => {
  it('scenario 1 — a name, then the code: signed in as an agent of the inviting organization', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { id } = await seedInvitation({ organizationId: admin.organizationId, invitedBy: admin.userId })

    const res = await accept('invite_token_abc', { name: 'Luis Agente' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: AGENT_EMAIL })
    expect(res.headers.getSetCookie()).toHaveLength(0)

    const user = await env.DB.prepare(
      'SELECT name, role, status, email_verified, organization_id FROM users WHERE email = ?',
    )
      .bind(AGENT_EMAIL)
      .first()
    expect(user).toEqual({
      name: 'Luis Agente',
      role: 'agent',
      status: 'active',
      email_verified: 1,
      organization_id: admin.organizationId,
    })
    const invitation = await env.DB.prepare('SELECT status FROM invitations WHERE id = ?').bind(id).first()
    expect(invitation).toEqual({ status: 'accepted' })

    const [mail] = await waitForEmails(sent, 1)
    expect(mail!.to).toBe(AGENT_EMAIL)
    const signIn = await signInWithCode(AGENT_EMAIL, codeIn(mail!))
    expect(signIn.status).toBe(200)
    const me = await SELF.fetch(`${API}/me`, { headers: { Cookie: withCookies('', signIn) } })
    expect(((await me.json()) as any).user).toMatchObject({
      email: AGENT_EMAIL,
      role: 'agent',
      organizationId: admin.organizationId,
    })
  })

  it('scenario 2 — an invitation stored before migration 0071 lowercased it still resolves', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      identity: 'Agente@Empresa.COM',
    })
    const res = await accept('invite_token_abc', { name: 'Luis Agente' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: AGENT_EMAIL })
    const row = await env.DB.prepare('SELECT email FROM users WHERE role = ?').bind('agent').first()
    expect(row).toEqual({ email: AGENT_EMAIL })
  })

  it('scenario 3 — a used or expired token → 400 INVALID_TOKEN, no account created', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      token: 'used',
      status: 'accepted',
    })
    await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      identity: 'otro@empresa.com',
      token: 'late',
      expiresInSeconds: -60,
    })
    for (const token of ['used', 'late', 'does_not_exist']) {
      const res = await accept(token, { name: 'Luis' })
      expect(res.status, token).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('INVALID_TOKEN')
    }
    const agents = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'agent'").first<{ n: number }>()
    expect(agents?.n).toBe(0)
  })

  it('accepting twice: the second time the token is used → 400 INVALID_TOKEN', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedInvitation({ organizationId: admin.organizationId, invitedBy: admin.userId })
    expect((await accept('invite_token_abc', { name: 'Luis' })).status).toBe(200)
    const again = await accept('invite_token_abc', { name: 'Luis' })
    expect(again.status).toBe(400)
    expect(((await again.json()) as any).error.code).toBe('INVALID_TOKEN')
  })

  it('scenario 4 — the address got an account meanwhile → 409 EMAIL_ALREADY_EXISTS', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedInvitation({ organizationId: admin.organizationId, invitedBy: admin.userId })
    await seedUser({ email: AGENT_EMAIL, role: 'admin' })

    const res = await accept('invite_token_abc', { name: 'Luis' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('EMAIL_ALREADY_EXISTS')
  })

  it('no name → 400 VALIDATION_ERROR; no password is asked for', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedInvitation({ organizationId: admin.organizationId, invitedBy: admin.userId })
    const res = await accept('invite_token_abc', {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
  })
})
