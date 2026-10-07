import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { seedUser, clearFullDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// retire-affiliates US1–US2 — specs/001-retire-affiliates/spec.md.
//
// The affiliate program and its shift operators are gone from the code. Since migration 0069
// (drop-affiliate-tables) their tables and columns are gone from D1, and since migration 0070
// (delete-legacy-affiliates) so is every user row stored with role `affiliate`. The cases that
// proved the code treated such a row safely — the refusal (D3) and the legacy seller's money
// (D5, D6) — left with the guards they tested (delete-legacy-affiliates D5, D6, D9). What stays:
// the retired addresses answer 404, and a shift-operator cookie opens nothing.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const API = 'http://api.local/api'
const errCode = (json: any): string | undefined => json?.error?.code

// An org with its admin and an agent.
const seedOrg = async (): Promise<{ adminId: string; agentId: string }> => {
  const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const agent = await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: admin.organizationId })
  return { adminId: admin.userId, agentId: agent.userId }
}

beforeEach(clearFullDb)

// ---------------------------------------------------------------------------
// US1 — the product has two roles again
// ---------------------------------------------------------------------------
describe('retire-affiliates US1 — no affiliate or operator surface remains', () => {
  it('every retired address answers 404 (D11)', async () => {
    await seedOrg()
    const companyId = crypto.randomUUID()
    const operatorAccessToken = crypto.randomUUID()

    const retired: Array<[string, string, string]> = [
      ['GET', '/affiliates', ADMIN_EMAIL],
      ['POST', '/affiliates', ADMIN_EMAIL],
      ['GET', `/affiliates/${companyId}`, ADMIN_EMAIL],
      ['PUT', `/affiliates/${companyId}/commissions`, ADMIN_EMAIL],
      ['POST', `/affiliates/${companyId}/invite`, ADMIN_EMAIL],
      ['GET', `/affiliates/${companyId}/report?from=2020-01-01&to=2999-12-31`, ADMIN_EMAIL],
      ['GET', '/affiliate/operators', AGENT_EMAIL],
      ['POST', '/affiliate/operators', AGENT_EMAIL],
      ['GET', `/operator/access/${operatorAccessToken}`, AGENT_EMAIL],
      ['POST', `/operator/access/${operatorAccessToken}/login`, AGENT_EMAIL],
      ['POST', '/operator/logout', AGENT_EMAIL],
    ]
    for (const [method, path, email] of retired) {
      const res = await SELF.fetch(`${API}${path}`, {
        method,
        headers: jsonAuth(email),
        body: method === 'GET' ? undefined : '{}',
      })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it('/api/me answers the user alone — no operator, no company link (D9)', async () => {
    const { agentId } = await seedOrg()
    const res = await SELF.fetch(`${API}/me`, { headers: auth(AGENT_EMAIL) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Object.keys(body)).toEqual(['user'])
    expect(body.user).toMatchObject({ userId: agentId, role: 'agent' })
    expect(body.user).not.toHaveProperty('affiliateCompanyId')
  })
})

// ---------------------------------------------------------------------------
// US2 — a leftover shift link opens nothing
// ---------------------------------------------------------------------------
describe('retire-affiliates US2 — the shift session is closed', () => {
  it('ignores a shift-operator cookie: alone it is no session (D4)', async () => {
    await seedOrg()
    const res = await SELF.fetch(`${API}/me`, { headers: { Cookie: 'gm_op=any.signed.token' } })
    expect(res.status).toBe(401)
    expect(errCode(await res.json())).toBe('UNAUTHORIZED')
  })

  it('ignores a shift-operator cookie beside a real session: the user is who they are (D4)', async () => {
    const { agentId } = await seedOrg()
    const res = await SELF.fetch(`${API}/me`, {
      headers: { Cookie: `gm_op=any.signed.token; gm_access=${buildFakeJwt(AGENT_EMAIL)}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).user.userId).toBe(agentId)
  })
})
