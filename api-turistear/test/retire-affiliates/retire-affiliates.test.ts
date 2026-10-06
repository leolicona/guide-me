import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearFullDb, seedFolioLedgerRows } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// retire-affiliates US1–US3 — specs/001-retire-affiliates/spec.md.
//
// The affiliate program and its shift operators are gone from the code, but their rows are not
// gone from D1 (D1): prod still holds companies, commission rows, invitations and one affiliate
// user with a cash sale. Every legacy row here is seeded in raw SQL — the code no longer maps the
// tables (D2) — and each test proves the code behaves as if the feature never existed, without
// losing a peso that was already recorded.

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
  companyId: string
  operatorAccessToken: string
  invitationToken: string
  folioId: string
}

// The prod shape, reduced: an org with its admin and an agent, plus one affiliate company with its
// manager (role `affiliate`), a pending invitation, a shift operator, and the manager's one cash
// sale (MXN 360.00), stamped with the company and the operator as the retired code stamped it.
const seedLegacyAffiliate = async (
  organizationId?: string,
  emails = { admin: ADMIN_EMAIL, agent: AGENT_EMAIL, legacy: LEGACY_EMAIL },
): Promise<LegacyAffiliate> => {
  const admin = await seedUser({ email: emails.admin, role: 'admin', organizationId })
  const org = admin.organizationId
  const agent = await seedUser({ email: emails.agent, role: 'agent', organizationId: org })

  const companyId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO affiliate_companies (id, organization_id, name, status) VALUES (?, ?, 'Hotel Maya', 'active')`,
  )
    .bind(companyId, org)
    .run()

  const legacyUserId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, role, status, plan, affiliate_company_id, position)
     VALUES (?, ?, 'Gerente Maya', ?, 'H', 'S', 'affiliate', 'active', 'free', ?, 'Gerente')`,
  )
    .bind(legacyUserId, org, emails.legacy, companyId)
    .run()

  const invitationToken = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO affiliate_invitations (id, organization_id, affiliate_company_id, identity, token, invited_by, status, expires_at)
     VALUES (?, ?, ?, 'nuevo@hotelmaya.com', ?, ?, 'pending', ?)`,
  )
    .bind(crypto.randomUUID(), org, companyId, invitationToken, admin.userId, nowSec() + 86_400)
    .run()

  const operatorId = crypto.randomUUID()
  const operatorAccessToken = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO affiliate_operators (id, organization_id, affiliate_company_id, manager_id, name, phone, access_token)
     VALUES (?, ?, ?, ?, 'Cajera Turno A', '5215512345678', ?)`,
  )
    .bind(operatorId, org, companyId, legacyUserId, operatorAccessToken)
    .run()

  const folioId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, affiliate_company_id, operator_id, customer_name, status,
        subtotal, discount_total, total, amount_paid, commission_amount,
        cancellation_clawback, cancelled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Huésped', 'paid', 36000, 0, 36000, 36000, 0, 0, NULL, ?, ?)`,
  )
    .bind(folioId, org, legacyUserId, companyId, operatorId, ts, ts)
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
    companyId,
    operatorAccessToken,
    invitationToken,
    folioId,
  }
}

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour sin vender', NULL, 150000, 100000, 12, 'percent', 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, nowSec(), nowSec())
    .run()
  return id
}

// The shared wipe knows nothing of the retired tables, so release them first: null the child keys
// that point at them, then delete them, then hand over to clearFullDb.
const clearLegacyAndAll = async () => {
  await env.DB.exec('DELETE FROM affiliate_invitations')
  await env.DB.exec('DELETE FROM affiliate_commissions')
  await env.DB.exec('UPDATE folios SET operator_id = NULL, affiliate_company_id = NULL')
  await env.DB.exec('UPDATE folio_payments SET operator_id = NULL')
  await env.DB.exec('UPDATE folio_events SET operator_id = NULL')
  await env.DB.exec('DELETE FROM affiliate_operators')
  await env.DB.exec('UPDATE users SET affiliate_company_id = NULL')
  await env.DB.exec('DELETE FROM affiliate_companies')
  await clearFullDb()
}

beforeEach(clearLegacyAndAll)

// ---------------------------------------------------------------------------
// US1 — the product has two roles again
// ---------------------------------------------------------------------------
describe('retire-affiliates US1 — no affiliate or operator surface remains', () => {
  it('every retired address answers 404 (D11)', async () => {
    const { companyId, operatorAccessToken } = await seedLegacyAffiliate()

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

  it('treats a pending affiliate invitation as an invalid one (FR-004)', async () => {
    const { invitationToken } = await seedLegacyAffiliate()
    const lookup = await SELF.fetch(`${API}/auth/invite/accept?token=${invitationToken}`)
    expect(lookup.status).toBe(400)
    expect(errCode(await lookup.json())).toBe('INVALID_TOKEN')

    const complete = await SELF.fetch(`${API}/auth/invite/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invitationToken, name: 'Nuevo', password: 'password123' }),
    })
    expect(complete.status).toBe(400)
    expect(errCode(await complete.json())).toBe('INVALID_TOKEN')
    const users = await env.DB.prepare(`SELECT count(*) AS n FROM users WHERE email = 'nuevo@hotelmaya.com'`).first<{ n: number }>()
    expect(users!.n).toBe(0)
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

  it('a legacy commission row does not block deleting an unsold service (D7)', async () => {
    const { organizationId, companyId } = await seedLegacyAffiliate()
    const serviceId = await seedService(organizationId)
    await env.DB.prepare(
      `INSERT INTO affiliate_commissions (id, organization_id, affiliate_company_id, service_id, commission_type, commission_value)
       VALUES (?, ?, ?, ?, 'percent', 1500)`,
    )
      .bind(crypto.randomUUID(), organizationId, companyId, serviceId)
      .run()

    const res = await SELF.fetch(`${API}/services/${serviceId}`, {
      method: 'DELETE',
      headers: auth(ADMIN_EMAIL),
    })
    expect(res.status).toBe(200)
    const left = await env.DB.prepare(
      'SELECT (SELECT count(*) FROM services WHERE id = ?1) AS svc, (SELECT count(*) FROM affiliate_commissions WHERE service_id = ?1) AS rows_left',
    )
      .bind(serviceId)
      .first<{ svc: number; rows_left: number }>()
    expect(left).toEqual({ svc: 0, rows_left: 0 })
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
