import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import {
  seedUser,
  seedTwoOrgs,
  clearTenancyDb,
} from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Staff Management — list / edit / deactivate / reactivate agents.
// Spec: docs/staff/staff-management.spec.md (Scenarios 1–15).
// Multitenancy isolation (13–15) uses the shared `seedTwoOrgs` helper, per
// docs/multitenancy/multitenancy.spec.md (B1, B3, B4) and CLAUDE.md.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

/** Mock a SUCCESSFUL refresh so the only thing that can block a request is the
 *  post-refresh status gate (see Scenario 9). */
const mockSuccessfulRefresh = (identity: string) => {
  vi.spyOn(env.AGNOSTIC_AUTH_API, 'fetch').mockImplementation(
    async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (new URL(url).pathname === '/auth/refresh') {
        return new Response(
          JSON.stringify({
            success: true,
            data: { jwt: buildFakeJwt(identity), refreshToken: 'fresh-token' },
          }),
          { status: 200 },
        )
      }
      return new Response('{"success":false}', { status: 404 })
    },
  )
}

/** Read a single user row straight from D1 (bypasses the API) for after-state
 *  assertions on UPDATE/DELETE isolation. */
const getUserRow = async (id: string) => {
  const r = await env.DB.prepare(
    'SELECT id, name, email, role, status, base_commission FROM users WHERE id = ?',
  )
    .bind(id)
    .first<{
      id: string
      name: string
      email: string
      role: string
      status: string
      base_commission: number
    }>()
  return r
}

beforeEach(clearTenancyDb)
afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
// US-A06 — GET /api/agents
// ---------------------------------------------------------------------------
describe('US-A06 — list agents (GET /api/agents)', () => {
  it('Scenario 1 — lists agents with commission, excludes admin, ordered by name, no password fields', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    await seedUser({
      email: 'zara@empresa.com',
      name: 'Zara',
      role: 'agent',
      status: 'active',
      organizationId,
    })
    const { userId: anaId } = await seedUser({
      email: 'ana@empresa.com',
      name: 'Ana',
      role: 'agent',
      status: 'suspended',
      organizationId,
    })
    // Give one agent a known commission to prove it round-trips (basis points).
    await env.DB.prepare('UPDATE users SET base_commission = ? WHERE id = ?')
      .bind(1050, anaId)
      .run()

    const res = await SELF.fetch('http://api.local/api/agents', {
      headers: auth(ADMIN_EMAIL),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { agents: any[] }

    // Admin excluded → exactly the two agents.
    expect(body.agents).toHaveLength(2)
    // Ordered by name asc.
    expect(body.agents.map((a) => a.name)).toEqual(['Ana', 'Zara'])
    // Status + commission present; commission in basis points.
    expect(body.agents[0]).toMatchObject({
      name: 'Ana',
      status: 'suspended',
      base_commission: 1050,
    })
    expect(body.agents[1]).toMatchObject({ status: 'active', base_commission: 0 })
    // No secret fields ever serialized.
    for (const a of body.agents) {
      expect(a).not.toHaveProperty('password_hash')
      expect(a).not.toHaveProperty('password_salt')
      expect(a).not.toHaveProperty('passwordHash')
    }
  })

  it('Scenario 2 — empty roster returns { agents: [] }', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await SELF.fetch('http://api.local/api/agents', {
      headers: auth(ADMIN_EMAIL),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ agents: [] })
  })

  it('Scenario 3 — an agent is forbidden', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      organizationId,
    })

    const res = await SELF.fetch('http://api.local/api/agents', {
      headers: auth(AGENT_EMAIL),
    })

    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('FORBIDDEN')
  })
})

// ---------------------------------------------------------------------------
// US-A07 — PUT /api/agents/:id
// ---------------------------------------------------------------------------
describe('US-A07 — edit agent (PUT /api/agents/:id)', () => {
  it('Scenario 4 — edits name/phone/commission; email/role/status unchanged', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { userId } = await seedUser({
      email: AGENT_EMAIL,
      name: 'Old Name',
      role: 'agent',
      status: 'active',
      organizationId,
    })

    const res = await SELF.fetch(`http://api.local/api/agents/${userId}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'New Name',
        phone: '+52 55 9999 0000',
        base_commission: 1200,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { agent: any }
    expect(body.agent).toMatchObject({
      id: userId,
      name: 'New Name',
      phone: '+52 55 9999 0000',
      base_commission: 1200,
      email: AGENT_EMAIL, // unchanged
      status: 'active', // unchanged
    })

    // Immutables verified directly in D1.
    const row = await getUserRow(userId)
    expect(row).toMatchObject({
      email: AGENT_EMAIL,
      role: 'agent',
      status: 'active',
      name: 'New Name',
      base_commission: 1200,
    })
  })

  it('Scenario 5 — invalid base_commission (-1 / 10001 / float) → 400, no change', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { userId } = await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      organizationId,
    })

    for (const bad of [-1, 10001, 10.5]) {
      const res = await SELF.fetch(`http://api.local/api/agents/${userId}`, {
        method: 'PUT',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({ name: 'X', base_commission: bad }),
      })
      expect(res.status, `base_commission=${bad}`).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    }

    // Untouched.
    expect((await getUserRow(userId))?.base_commission).toBe(0)
  })

  it('Scenario 6 — editing unknown id → 404', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await SELF.fetch('http://api.local/api/agents/does-not-exist', {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'X', base_commission: 0 }),
    })

    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
  })

  it('Scenario 6 — editing an admin id → 404 (role-scoped, no admin mutation)', async () => {
    const { userId: adminId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })

    const res = await SELF.fetch(`http://api.local/api/agents/${adminId}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'Hacked', base_commission: 9999 }),
    })

    expect(res.status).toBe(404)
    const row = await getUserRow(adminId)
    expect(row?.name).not.toBe('Hacked')
    expect(row?.base_commission).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// US-A08 — deactivate / reactivate + access enforcement
// ---------------------------------------------------------------------------
describe('US-A08 — deactivate / reactivate', () => {
  it('Scenario 7 — deactivate sets status=suspended', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { userId } = await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      status: 'active',
      organizationId,
    })

    const res = await SELF.fetch(
      `http://api.local/api/agents/${userId}/deactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as any).agent.status).toBe('suspended')
    expect((await getUserRow(userId))?.status).toBe('suspended')
  })

  it('Scenario 8 — a suspended user is rejected on a valid token and cookies are cleared', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      status: 'suspended',
      organizationId,
    })

    const res = await SELF.fetch('http://api.local/api/me', {
      headers: auth(AGENT_EMAIL),
    })

    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('ACCOUNT_SUSPENDED')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('gm_access=')
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
  })

  it('Scenario 9 — a suspended user cannot refresh back in (post-refresh branch re-checks status)', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      status: 'suspended',
      organizationId,
    })
    mockSuccessfulRefresh(AGENT_EMAIL)

    const res = await SELF.fetch('http://api.local/api/me', {
      headers: {
        Cookie: `gm_access=${buildFakeJwt(AGENT_EMAIL, -10)}; gm_refresh=valid-refresh-token`,
      },
    })

    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('ACCOUNT_SUSPENDED')
  })

  it('control — an active user passes the same expired-access + successful-refresh flow', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      status: 'active',
      organizationId,
    })
    mockSuccessfulRefresh(AGENT_EMAIL)

    const res = await SELF.fetch('http://api.local/api/me', {
      headers: {
        Cookie: `gm_access=${buildFakeJwt(AGENT_EMAIL, -10)}; gm_refresh=valid-refresh-token`,
      },
    })

    expect(res.status).toBe(200)
  })

  it('Scenario 10 — reactivate restores status=active', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { userId } = await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      status: 'suspended',
      organizationId,
    })

    const res = await SELF.fetch(
      `http://api.local/api/agents/${userId}/reactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as any).agent.status).toBe('active')
    expect((await getUserRow(userId))?.status).toBe('active')
  })

  it('Scenario 11 — deactivate is idempotent', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { userId } = await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      status: 'suspended',
      organizationId,
    })

    const res = await SELF.fetch(
      `http://api.local/api/agents/${userId}/deactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as any).agent.status).toBe('suspended')
  })

  it('Scenario 12 — deactivating unknown id → 404', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await SELF.fetch('http://api.local/api/agents/nope/deactivate', {
      method: 'POST',
      headers: auth(ADMIN_EMAIL),
    })

    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
  })

  it('Scenario 12 — deactivating an admin id → 404 (cannot suspend an admin / self)', async () => {
    const { userId: adminId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })

    const res = await SELF.fetch(
      `http://api.local/api/agents/${adminId}/deactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )

    expect(res.status).toBe(404)
    expect((await getUserRow(adminId))?.status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation — Scenarios 13–15 (B4 / B3 / B1)
// ---------------------------------------------------------------------------
describe('Multitenancy isolation', () => {
  it('Scenario 13 (B4) — list is scoped to the caller’s org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedUser({
      email: 'agent-a@empresa.com',
      name: 'Agent A',
      role: 'agent',
      organizationId: orgA.organizationId,
    })
    await seedUser({
      email: 'agent-b@empresa.com',
      name: 'Agent B',
      role: 'agent',
      organizationId: orgB.organizationId,
    })

    const res = await SELF.fetch('http://api.local/api/agents', {
      headers: auth(orgA.adminEmail),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { agents: any[] }
    expect(body.agents).toHaveLength(1)
    expect(body.agents[0].email).toBe('agent-a@empresa.com')
    expect(body.agents.some((a) => a.email === 'agent-b@empresa.com')).toBe(false)
  })

  it('Scenario 14 (B3) — cross-org edit/deactivate/reactivate → 404, target unchanged', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { userId: agentBId } = await seedUser({
      email: 'agent-b@empresa.com',
      name: 'Agent B',
      role: 'agent',
      status: 'active',
      organizationId: orgB.organizationId,
    })

    // Org A's admin attacks Org B's agent by id.
    const put = await SELF.fetch(`http://api.local/api/agents/${agentBId}`, {
      method: 'PUT',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({ name: 'Hacked', base_commission: 9999 }),
    })
    const deact = await SELF.fetch(
      `http://api.local/api/agents/${agentBId}/deactivate`,
      { method: 'POST', headers: auth(orgA.adminEmail) },
    )
    const react = await SELF.fetch(
      `http://api.local/api/agents/${agentBId}/reactivate`,
      { method: 'POST', headers: auth(orgA.adminEmail) },
    )

    expect(put.status).toBe(404)
    expect(deact.status).toBe(404)
    expect(react.status).toBe(404)

    // Org B's agent is completely untouched — and no error revealed it exists.
    const row = await getUserRow(agentBId)
    expect(row).toMatchObject({
      name: 'Agent B',
      status: 'active',
      base_commission: 0,
    })
  })

  it('Scenario 15 (B1) — injected organizationId in PUT body is ignored', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { userId: agentAId } = await seedUser({
      email: 'agent-a@empresa.com',
      name: 'Agent A',
      role: 'agent',
      organizationId: orgA.organizationId,
    })

    const res = await SELF.fetch(`http://api.local/api/agents/${agentAId}`, {
      method: 'PUT',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        name: 'Renamed',
        base_commission: 500,
        organizationId: orgB.organizationId, // must be stripped by Zod
      }),
    })

    expect(res.status).toBe(200)

    // Row stays in org A; the injected org is never applied.
    const row = await env.DB.prepare(
      'SELECT organization_id FROM users WHERE id = ?',
    )
      .bind(agentAId)
      .first<{ organization_id: string }>()
    expect(row?.organization_id).toBe(orgA.organizationId)
    expect(row?.organization_id).not.toBe(orgB.organizationId)
  })
})
