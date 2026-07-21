import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { buildFakeJwt } from '../helpers/jwt'

const ADMIN_EMAIL = 'admin@empresa.com'
const ADMIN_NAME = 'Admin User'
const AGENT_EMAIL = 'agente@empresa.com'
const AGENT_NAME = 'Carlos López'
const AGENT_PASSWORD = 'agentPassword123!'
const ORG_NAME = 'Empresa S.A.'

const clearDb = async () => {
  await env.DB.exec('DELETE FROM invitations')
  await env.DB.exec('DELETE FROM users')
  await env.DB.exec('DELETE FROM organizations')
}

interface SeedUserOptions {
  email?: string
  name?: string
  status?: 'unverified' | 'active' | 'suspended'
  role?: 'admin' | 'agent'
  organizationId?: string
}

const seedUser = async ({
  email = ADMIN_EMAIL,
  name = ADMIN_NAME,
  status = 'active',
  role = 'admin',
  organizationId,
}: SeedUserOptions = {}): Promise<{ userId: string; organizationId: string }> => {
  const orgId = organizationId ?? crypto.randomUUID()
  const userId = crypto.randomUUID()

  if (!organizationId) {
    await env.DB.prepare(
      'INSERT INTO organizations (id, name) VALUES (?, ?)',
    )
      .bind(orgId, ORG_NAME)
      .run()
  }

  await env.DB.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, phone, role, status, plan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      orgId,
      name,
      email,
      'STORED_HASH',
      'STORED_SALT',
      '+52 55 1234 5678',
      role,
      status,
      'free',
    )
    .run()

  return { userId, organizationId: orgId }
}

interface SeedInvitationOptions {
  organizationId: string
  invitedBy: string
  identity?: string
  token?: string
  status?: 'pending' | 'accepted' | 'expired'
  expiresInSeconds?: number
}

const seedInvitation = async ({
  organizationId,
  invitedBy,
  identity = AGENT_EMAIL,
  token = 'invite_token_abc',
  status = 'pending',
  expiresInSeconds = 60 * 60 * 24 * 7,
}: SeedInvitationOptions): Promise<{ id: string; token: string }> => {
  const id = crypto.randomUUID()
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds
  await env.DB.prepare(
    `INSERT INTO invitations (id, organization_id, identity, identity_type, token, invited_by, status, expires_at)
     VALUES (?, ?, ?, 'email', ?, ?, ?, ?)`,
  )
    .bind(id, organizationId, identity, token, invitedBy, status, expiresAt)
    .run()
  return { id, token }
}

const mockAgnosticAuth = (
  routes: Partial<
    Record<
      | '/auth/hash'
      | '/auth/initiate'
      | '/auth/verify'
      | '/auth/verify-password'
      | '/auth/refresh'
      | '/auth/token/revoke',
      (body: unknown) => Response
    >
  >,
) => {
  const calls: Array<{ pathname: string; body: unknown }> = []
  vi.spyOn(env.AGNOSTIC_AUTH_API, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const pathname = new URL(url).pathname as keyof typeof routes
      const parsedBody = init?.body ? JSON.parse(init.body as string) : undefined
      calls.push({ pathname, body: parsedBody })
      const handler = routes[pathname]
      if (handler) return handler(parsedBody)
      return new Response('{"success":false}', { status: 404 })
    },
  )
  return calls
}

const mockResend = () => {
  const calls: Array<{ to: unknown; from: unknown; subject: unknown; html: unknown }> = []
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    if (url.startsWith('https://api.resend.com/emails')) {
      const body = JSON.parse(init?.body as string)
      calls.push(body)
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
    }
    return original(input, init)
  })
  return calls
}

beforeEach(async () => {
  await clearDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Agent Invitation — POST /api/agents/invite', () => {
  it('Scenario 1: admin invites agent successfully', async () => {
    const admin = await seedUser()
    const adminJwt = buildFakeJwt(ADMIN_EMAIL)
    const resendCalls = mockResend()

    const res = await SELF.fetch('http://api.local/api/agents/invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gm_access=${adminJwt}`,
      },
      body: JSON.stringify({ identity: AGENT_EMAIL }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { message: string }
    expect(body.message).toBe('Invitación enviada.')

    const invitationRow = await env.DB.prepare(
      'SELECT identity, identity_type, status, organization_id, invited_by, token, expires_at FROM invitations WHERE identity = ?',
    )
      .bind(AGENT_EMAIL)
      .first<{
        identity: string
        identity_type: string
        status: string
        organization_id: string
        invited_by: string
        token: string
        expires_at: number
      }>()

    expect(invitationRow).toBeTruthy()
    expect(invitationRow!.identity).toBe(AGENT_EMAIL)
    expect(invitationRow!.identity_type).toBe('email')
    expect(invitationRow!.status).toBe('pending')
    expect(invitationRow!.organization_id).toBe(admin.organizationId)
    expect(invitationRow!.invited_by).toBe(admin.userId)

    const nowSeconds = Math.floor(Date.now() / 1000)
    const sevenDaysSeconds = 60 * 60 * 24 * 7
    expect(invitationRow!.expires_at).toBeGreaterThan(nowSeconds + sevenDaysSeconds - 60)
    expect(invitationRow!.expires_at).toBeLessThan(nowSeconds + sevenDaysSeconds + 60)

    expect(resendCalls.length).toBe(1)
    expect(resendCalls[0].to).toBe(AGENT_EMAIL)
    expect((resendCalls[0].html as string)).toContain(
      `/invite/accept?token=${invitationRow!.token}`,
    )
  })

  it('Scenario 3: returns 401 UNAUTHORIZED when no gm_access cookie', async () => {
    const resendCalls = mockResend()

    const res = await SELF.fetch('http://api.local/api/agents/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: AGENT_EMAIL }),
    })

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')

    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM invitations').first<{ c: number }>()
    expect(count?.c).toBe(0)
    expect(resendCalls.length).toBe(0)
  })

  it('Scenario 4: returns 403 FORBIDDEN when caller has role=agent', async () => {
    await seedUser({ role: 'agent' })
    const agentJwt = buildFakeJwt(ADMIN_EMAIL)
    const resendCalls = mockResend()

    const res = await SELF.fetch('http://api.local/api/agents/invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gm_access=${agentJwt}`,
      },
      body: JSON.stringify({ identity: AGENT_EMAIL }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')

    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM invitations').first<{ c: number }>()
    expect(count?.c).toBe(0)
    expect(resendCalls.length).toBe(0)
  })

  it('Scenario 5: returns 409 IDENTITY_ALREADY_EXISTS when identity belongs to an existing user', async () => {
    const admin = await seedUser()
    await seedUser({
      email: AGENT_EMAIL,
      name: 'Existing Agent',
      role: 'agent',
      status: 'active',
      organizationId: admin.organizationId,
    })
    const adminJwt = buildFakeJwt(ADMIN_EMAIL)
    const resendCalls = mockResend()

    const res = await SELF.fetch('http://api.local/api/agents/invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gm_access=${adminJwt}`,
      },
      body: JSON.stringify({ identity: AGENT_EMAIL }),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('IDENTITY_ALREADY_EXISTS')

    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM invitations').first<{ c: number }>()
    expect(count?.c).toBe(0)
    expect(resendCalls.length).toBe(0)
  })

  it('Scenario 6: a new invitation invalidates the previous pending one', async () => {
    const admin = await seedUser()
    const previous = await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      token: 'old_token',
    })
    const adminJwt = buildFakeJwt(ADMIN_EMAIL)
    mockResend()

    const res = await SELF.fetch('http://api.local/api/agents/invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gm_access=${adminJwt}`,
      },
      body: JSON.stringify({ identity: AGENT_EMAIL }),
    })

    expect(res.status).toBe(201)

    const previousRow = await env.DB.prepare(
      'SELECT status FROM invitations WHERE id = ?',
    )
      .bind(previous.id)
      .first<{ status: string }>()
    expect(previousRow?.status).toBe('expired')

    const pendingCount = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM invitations WHERE identity = ? AND status = 'pending'",
    )
      .bind(AGENT_EMAIL)
      .first<{ c: number }>()
    expect(pendingCount?.c).toBe(1)
  })

  it("Regression (BUG-011): inviting an identity never expires ANOTHER org's pending invitation", async () => {
    const ADMIN_B_EMAIL = 'admin-b@otra.com'
    const orgA = await seedUser()
    const orgB = await seedUser({ email: ADMIN_B_EMAIL })
    // Org A already holds a pending invitation for the same identity.
    const inviteA = await seedInvitation({
      organizationId: orgA.organizationId,
      invitedBy: orgA.userId,
      token: 'org_a_token',
    })
    mockResend()

    // Org B's admin invites the SAME email.
    const res = await SELF.fetch('http://api.local/api/agents/invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gm_access=${buildFakeJwt(ADMIN_B_EMAIL)}`,
      },
      body: JSON.stringify({ identity: AGENT_EMAIL }),
    })
    expect(res.status).toBe(201)

    // Org A's invitation is untouched (the supersede UPDATE is org-scoped)…
    const rowA = await env.DB.prepare('SELECT status FROM invitations WHERE id = ?')
      .bind(inviteA.id)
      .first<{ status: string }>()
    expect(rowA?.status).toBe('pending')

    // …and org B got its own, independent pending invitation.
    const rowB = await env.DB.prepare(
      "SELECT status FROM invitations WHERE organization_id = ? AND identity = ? AND status = 'pending'",
    )
      .bind(orgB.organizationId, AGENT_EMAIL)
      .first<{ status: string }>()
    expect(rowB?.status).toBe('pending')
  })
})

describe('Accept Invitation — GET /api/auth/invite/accept', () => {
  it('Scenario 7: returns invitation details for a valid pending token', async () => {
    const admin = await seedUser()
    await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      token: 'valid_token',
    })

    const res = await SELF.fetch(
      'http://api.local/api/auth/invite/accept?token=valid_token',
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      invitation: {
        identity: string
        identity_type: string
        organization_name: string
      }
    }
    expect(body.invitation.identity).toBe(AGENT_EMAIL)
    expect(body.invitation.identity_type).toBe('email')
    expect(body.invitation.organization_name).toBe(ORG_NAME)

    const setCookies = res.headers.getSetCookie?.() ?? []
    expect(setCookies.length).toBe(0)

    const invitationRow = await env.DB.prepare(
      'SELECT status FROM invitations WHERE token = ?',
    )
      .bind('valid_token')
      .first<{ status: string }>()
    expect(invitationRow?.status).toBe('pending')
  })

  it('Scenario 8: returns 400 INVALID_TOKEN for expired or inexistent token', async () => {
    const admin = await seedUser()
    await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      token: 'expired_token',
      expiresInSeconds: -60,
    })

    const expiredRes = await SELF.fetch(
      'http://api.local/api/auth/invite/accept?token=expired_token',
    )
    expect(expiredRes.status).toBe(400)
    const expiredBody = (await expiredRes.json()) as { error: { code: string } }
    expect(expiredBody.error.code).toBe('INVALID_TOKEN')

    const missingRes = await SELF.fetch(
      'http://api.local/api/auth/invite/accept?token=does_not_exist',
    )
    expect(missingRes.status).toBe(400)
    const missingBody = (await missingRes.json()) as { error: { code: string } }
    expect(missingBody.error.code).toBe('INVALID_TOKEN')
  })
})

describe('Complete Invitation — POST /api/auth/invite/complete', () => {
  it('Scenario 9: completes registration successfully and sets session cookies', async () => {
    const admin = await seedUser()
    await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      token: 'complete_token',
    })

    const jwt = buildFakeJwt(AGENT_EMAIL)
    const refreshToken = 'refresh_xyz'

    mockAgnosticAuth({
      '/auth/hash': () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { hash: 'HASHED_VALUE', salt: 'SALT_VALUE' },
          }),
          { status: 200 },
        ),
      '/auth/verify-password': () =>
        new Response(
          JSON.stringify({ success: true, data: { jwt, refreshToken } }),
          { status: 200 },
        ),
    })

    const res = await SELF.fetch('http://api.local/api/auth/invite/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'complete_token',
        name: AGENT_NAME,
        password: AGENT_PASSWORD,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { name: string; role: string } }
    expect(body.user.name).toBe(AGENT_NAME)
    expect(body.user.role).toBe('agent')

    const bodyStr = JSON.stringify(body)
    expect(bodyStr).not.toContain(jwt)
    expect(bodyStr).not.toContain(refreshToken)

    const userRow = await env.DB.prepare(
      'SELECT name, email, role, status, organization_id, password_hash FROM users WHERE email = ?',
    )
      .bind(AGENT_EMAIL)
      .first<{
        name: string
        email: string
        role: string
        status: string
        organization_id: string
        password_hash: string
      }>()
    expect(userRow).toBeTruthy()
    expect(userRow!.name).toBe(AGENT_NAME)
    expect(userRow!.role).toBe('agent')
    expect(userRow!.status).toBe('active')
    expect(userRow!.organization_id).toBe(admin.organizationId)
    expect(userRow!.password_hash).toBe('HASHED_VALUE')
    expect(userRow!.password_hash).not.toBe(AGENT_PASSWORD)

    const invitationRow = await env.DB.prepare(
      'SELECT status FROM invitations WHERE token = ?',
    )
      .bind('complete_token')
      .first<{ status: string }>()
    expect(invitationRow?.status).toBe('accepted')

    const setCookies = res.headers.getSetCookie?.() ?? []
    const cookieHeader = setCookies.join('\n')
    expect(cookieHeader).toMatch(/gm_access=/)
    expect(cookieHeader).toMatch(/gm_refresh=/)
    expect(cookieHeader).toMatch(/HttpOnly/i)
    expect(cookieHeader).toMatch(/Secure/i)
    expect(cookieHeader).toMatch(/SameSite=Lax/i)
    expect(cookieHeader).toMatch(/Max-Age=900/)
    expect(cookieHeader).toMatch(/Max-Age=5184000/)
  })

  it('Scenario 10: returns 400 INVALID_TOKEN when invitation has already been accepted', async () => {
    const admin = await seedUser()
    await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      token: 'used_token',
      status: 'accepted',
    })

    const hashSpy = vi.fn()
    mockAgnosticAuth({
      '/auth/hash': () => {
        hashSpy()
        return new Response(
          JSON.stringify({ success: true, data: { hash: 'h', salt: 's' } }),
          { status: 200 },
        )
      },
    })

    const res = await SELF.fetch('http://api.local/api/auth/invite/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'used_token',
        name: AGENT_NAME,
        password: AGENT_PASSWORD,
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_TOKEN')
    expect(hashSpy).not.toHaveBeenCalled()

    const userCount = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM users WHERE email = ?',
    )
      .bind(AGENT_EMAIL)
      .first<{ c: number }>()
    expect(userCount?.c).toBe(0)
  })

  it('Scenario 11: returns 400 VALIDATION_ERROR when name or password is missing', async () => {
    const admin = await seedUser()
    await seedInvitation({
      organizationId: admin.organizationId,
      invitedBy: admin.userId,
      token: 'fields_token',
    })

    const missingName = await SELF.fetch(
      'http://api.local/api/auth/invite/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'fields_token',
          password: AGENT_PASSWORD,
        }),
      },
    )
    expect(missingName.status).toBe(400)
    const missingNameBody = (await missingName.json()) as {
      error: { code: string }
    }
    expect(missingNameBody.error.code).toBe('VALIDATION_ERROR')

    const missingPassword = await SELF.fetch(
      'http://api.local/api/auth/invite/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'fields_token',
          name: AGENT_NAME,
        }),
      },
    )
    expect(missingPassword.status).toBe(400)
    const missingPasswordBody = (await missingPassword.json()) as {
      error: { code: string }
    }
    expect(missingPasswordBody.error.code).toBe('VALIDATION_ERROR')
  })
})
