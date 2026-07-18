import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { buildFakeJwt } from '../helpers/jwt'
import { clearTenancyDb, seedUser } from '../helpers/tenancy'

const ORG_NAME = 'Empresa S.A.'
const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

// Resend is called via global fetch inside the agent-invite handler (B1/B2).
// Intercept it so no real email is sent.
const mockResend = () => {
  const calls: Array<Record<string, unknown>> = []
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    if (url.startsWith('https://api.resend.com/emails')) {
      calls.push(JSON.parse(init?.body as string))
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
    }
    return original(input, init)
  })
  return calls
}

beforeEach(async () => {
  await clearTenancyDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Multitenancy — GET /api/organizations/me', () => {
  it('A1: authenticated admin reads their own organization', async () => {
    const admin = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
      organizationName: ORG_NAME,
    })

    const res = await SELF.fetch('http://api.local/api/organizations/me', {
      headers: { Cookie: `gm_access=${buildFakeJwt(ADMIN_EMAIL)}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      organization: { id: string; name: string }
    }
    expect(body.organization.id).toBe(admin.organizationId)
    expect(body.organization.name).toBe(ORG_NAME)
  })

  it('A2: authenticated agent reads their own organization', async () => {
    const agent = await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      organizationName: ORG_NAME,
    })

    const res = await SELF.fetch('http://api.local/api/organizations/me', {
      headers: { Cookie: `gm_access=${buildFakeJwt(AGENT_EMAIL)}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      organization: { id: string; name: string }
    }
    expect(body.organization.id).toBe(agent.organizationId)
    expect(body.organization.name).toBe(ORG_NAME)
  })

  it('A3: unauthenticated request returns 401 UNAUTHORIZED', async () => {
    const res = await SELF.fetch('http://api.local/api/organizations/me')

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })
})

describe('Multitenancy — tenant isolation invariants', () => {
  it('B1: organizationId injected in the request body is ignored', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    // A second org actually exists, so that IF the handler wrongly used the
    // injected id, the insert would succeed against org B (no FK error) and the
    // assertion below would catch the leak rather than failing on a 500.
    const otherOrgId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)')
      .bind(otherOrgId, 'Org B')
      .run()

    mockResend()

    const res = await SELF.fetch('http://api.local/api/agents/invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gm_access=${buildFakeJwt(ADMIN_EMAIL)}`,
      },
      body: JSON.stringify({
        identity: 'nuevo@empresa.com',
        organizationId: otherOrgId,
      }),
    })

    expect(res.status).toBe(201)

    const row = await env.DB.prepare(
      'SELECT organization_id FROM invitations WHERE identity = ?',
    )
      .bind('nuevo@empresa.com')
      .first<{ organization_id: string }>()

    expect(row?.organization_id).toBe(admin.organizationId)
    expect(row?.organization_id).not.toBe(otherOrgId)
  })

  it('B2: invitation write is scoped to the caller org from context', async () => {
    const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    mockResend()

    const res = await SELF.fetch('http://api.local/api/agents/invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gm_access=${buildFakeJwt(ADMIN_EMAIL)}`,
      },
      body: JSON.stringify({ identity: 'nuevo@empresa.com' }),
    })

    expect(res.status).toBe(201)

    const row = await env.DB.prepare(
      'SELECT organization_id FROM invitations WHERE identity = ?',
    )
      .bind('nuevo@empresa.com')
      .first<{ organization_id: string }>()

    expect(row?.organization_id).toBe(admin.organizationId)
  })
})
