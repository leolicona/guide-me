import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearFullDb, seedFolioLedgerRows } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// retire-affiliates US1–US3 — specs/001-retire-affiliates/spec.md.
//
// The affiliate program and its shift operators are gone from the code, and since migration 0069
// (drop-affiliate-tables) their tables and columns are gone from D1 too. What can still exist is a
// `users` row stored with role `affiliate` — prod kept one, with a cash sale — until the developer
// settles it outside the product. Each test proves the code treats such a row as if the feature
// never existed, without losing a peso that was already recorded.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'
const LEGACY_EMAIL = 'gerente@hotelmaya.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const API = 'http://api.local/api'
const nowSec = () => Math.floor(Date.now() / 1000)
const errCode = (json: any): string | undefined => json?.error?.code

interface LegacyAffiliate {
  organizationId: string
  adminId: string
  agentId: string
  legacyUserId: string
  folioId: string
}

// The prod shape, reduced: an org with its admin and an agent, plus the user row still stored with
// role `affiliate` and its one cash sale (MXN 360.00).
const seedLegacyAffiliate = async (
  organizationId?: string,
  emails = { admin: ADMIN_EMAIL, agent: AGENT_EMAIL, legacy: LEGACY_EMAIL },
): Promise<LegacyAffiliate> => {
  const admin = await seedUser({ email: emails.admin, role: 'admin', organizationId })
  const org = admin.organizationId
  const agent = await seedUser({ email: emails.agent, role: 'agent', organizationId: org })

  const legacyUserId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, role, status, plan)
     VALUES (?, ?, 'Gerente Maya', ?, 'H', 'S', 'affiliate', 'active', 'free')`,
  )
    .bind(legacyUserId, org, emails.legacy)
    .run()

  const folioId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, status,
        subtotal, discount_total, total, amount_paid, commission_amount,
        cancellation_clawback, cancelled_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Huésped', 'paid', 36000, 0, 36000, 36000, 0, 0, NULL, ?, ?)`,
  )
    .bind(folioId, org, legacyUserId, ts, ts)
    .run()
  await seedFolioLedgerRows({
    folioId,
    organizationId: org,
    agentId: legacyUserId,
    amountPaid: 36000,
    createdAt: ts,
  })

  return {
    organizationId: org,
    adminId: admin.userId,
    agentId: agent.userId,
    legacyUserId,
    folioId,
  }
}

beforeEach(clearFullDb)

// ---------------------------------------------------------------------------
// US1 — the product has two roles again
// ---------------------------------------------------------------------------
describe('retire-affiliates US1 — no affiliate or operator surface remains', () => {
  it('every retired address answers 404 (D11)', async () => {
    await seedLegacyAffiliate()
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
    const { agentId } = await seedLegacyAffiliate()
    const res = await SELF.fetch(`${API}/me`, { headers: auth(AGENT_EMAIL) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Object.keys(body)).toEqual(['user'])
    expect(body.user).toMatchObject({ userId: agentId, role: 'agent' })
    expect(body.user).not.toHaveProperty('affiliateCompanyId')
  })
})

// ---------------------------------------------------------------------------
// US2 — a leftover affiliate account or shift link opens nothing
// ---------------------------------------------------------------------------
describe('retire-affiliates US2 — the legacy account and the shift session are closed', () => {
  it('refuses the legacy role with 403 ACCOUNT_SUSPENDED and clears the session (D3)', async () => {
    await seedLegacyAffiliate()
    for (const path of ['/me', '/pos/services', '/cash/me']) {
      const res = await SELF.fetch(`${API}${path}`, { headers: auth(LEGACY_EMAIL) })
      expect(res.status, path).toBe(403)
      expect(errCode(await res.json()), path).toBe('ACCOUNT_SUSPENDED')
      const cookies = res.headers.get('Set-Cookie') ?? ''
      expect(cookies, path).toMatch(/gm_access=;/)
      expect(cookies, path).toMatch(/gm_refresh=;/)
    }
  })

  it('ignores a shift-operator cookie: alone it is no session (D4)', async () => {
    await seedLegacyAffiliate()
    const res = await SELF.fetch(`${API}/me`, { headers: { Cookie: 'gm_op=any.signed.token' } })
    expect(res.status).toBe(401)
    expect(errCode(await res.json())).toBe('UNAUTHORIZED')
  })

  it('ignores a shift-operator cookie beside a real session: the user is who they are (D4)', async () => {
    const { agentId } = await seedLegacyAffiliate()
    const res = await SELF.fetch(`${API}/me`, {
      headers: { Cookie: `gm_op=any.signed.token; gm_access=${buildFakeJwt(AGENT_EMAIL)}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).user.userId).toBe(agentId)
  })
})

// ---------------------------------------------------------------------------
// US3 — the money already recorded is never lost
// ---------------------------------------------------------------------------
describe('retire-affiliates US3 — legacy money stays readable and settleable', () => {
  it('keeps the legacy seller in the cash roster with their open balance (D5)', async () => {
    const { legacyUserId } = await seedLegacyAffiliate()
    const res = await SELF.fetch(`${API}/cash/balances`, { headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(200)
    const { balances } = (await res.json()) as any
    const row = balances.find((b: any) => b.agent.id === legacyUserId)
    expect(row).toBeDefined()
    expect(row.cash_collected).toBe(36000)
    expect(row.balance).toBe(36000)
    // The role and company tags left with the program (D9).
    expect(row).not.toHaveProperty('role')
    expect(row).not.toHaveProperty('affiliate_company')
  })

  it('lets the admin collect the legacy balance and pay the legacy seller out (D5)', async () => {
    const { legacyUserId } = await seedLegacyAffiliate()
    const collection = await SELF.fetch(`${API}/cash/collections`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ agent_id: legacyUserId, amount: 36000, note: 'Cierre del programa' }),
    })
    expect(collection.status).toBe(201)

    const payout = await SELF.fetch(`${API}/cash/payouts`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ agent_id: legacyUserId, amount: 100 }),
    })
    expect(payout.status).toBe(201)
  })

  it('keeps the legacy seller in the commission report and its CSV, labelled as stored (D6)', async () => {
    const { legacyUserId } = await seedLegacyAffiliate()
    const window = 'from=2020-01-01&to=2999-12-31'

    const res = await SELF.fetch(`${API}/reports/commissions?${window}`, { headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(200)
    const report = (await res.json()) as any
    const row = report.sellers.find((s: any) => s.seller_id === legacyUserId)
    expect(row).toMatchObject({ role: 'affiliate', sales_total: 36000, cash_collected: 36000 })
    expect(row).not.toHaveProperty('affiliate_company')
    expect(report.totals.sales_total).toBe(36000)

    const csv = await (
      await SELF.fetch(`${API}/reports/commissions/export?${window}`, { headers: auth(ADMIN_EMAIL) })
    ).text()
    expect(csv.split('\r\n')[0]).toBe(
      'seller,role,folios_sold,sales_total,cash_collected,electronic_total,commission_earned,confirmed_drops,payouts,net_owed',
    )
    expect(csv).toContain('Gerente Maya,affiliate,1,360.00,360.00')
  })

  it('isolation: another org never sees, reports or settles the legacy seller (constitution III)', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { legacyUserId } = await seedLegacyAffiliate(orgA.organizationId, {
      admin: 'admin2-a@empresa.com',
      agent: AGENT_EMAIL,
      legacy: LEGACY_EMAIL,
    })

    const balances = (await (
      await SELF.fetch(`${API}/cash/balances`, { headers: auth(orgB.adminEmail) })
    ).json()) as any
    expect(balances.balances.some((b: any) => b.agent.id === legacyUserId)).toBe(false)

    const report = (await (
      await SELF.fetch(`${API}/reports/commissions?from=2020-01-01&to=2999-12-31`, {
        headers: auth(orgB.adminEmail),
      })
    ).json()) as any
    expect(report.sellers).toHaveLength(0)

    const collection = await SELF.fetch(`${API}/cash/collections`, {
      method: 'POST',
      headers: jsonAuth(orgB.adminEmail),
      body: JSON.stringify({ agent_id: legacyUserId, amount: 100 }),
    })
    expect(collection.status).toBe(404)
  })
})
