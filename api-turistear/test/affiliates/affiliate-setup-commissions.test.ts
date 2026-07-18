import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import {
  seedUser,
  seedTwoOrgs,
  seedAffiliateCompany,
  clearAffiliateDb,
} from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Affiliate Setup & Commissions (admin). Spec: docs/affiliates/affiliate-setup-commissions.spec.md.
// Multitenancy isolation (B1/B3/B4 + cross-org service enable) via the shared seedTwoOrgs helper.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const mockResend = () => {
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://api.resend.com/emails')) {
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
    }
    return original(input, init)
  })
}

const seedService = async ({
  organizationId,
  name = 'City Tour',
  minimumPrice = 100000,
  status = 'active',
}: {
  organizationId: string
  name?: string
  minimumPrice?: number
  status?: 'active' | 'inactive'
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 'percent', 0, ?, ?, ?)`,
  )
    .bind(id, organizationId, name, 150000, minimumPrice, 12, status, ts, ts)
    .run()
  return id
}

const api = (path: string) => `http://api.local/api/affiliates${path}`

beforeEach(clearAffiliateDb)
afterEach(() => vi.restoreAllMocks())

describe('US-A54–A57 — wizard finalize (POST /api/affiliates)', () => {
  it('creates company + commission rows + invitations atomically', async () => {
    mockResend()
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const svc1 = await seedService({ organizationId, name: 'Canyon' })
    const svc2 = await seedService({ organizationId, name: 'Reef' })

    const res = await SELF.fetch(api(''), {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        company: { name: 'Hotel Maya', contact_email: 'ops@maya.com' },
        commissions: [
          { service_id: svc1, commission_type: 'percent', commission_value: 1500 },
          { service_id: svc2, commission_type: 'fixed', commission_value: 5000 },
        ],
        invites: ['concierge@maya.com', 'desk@maya.com'],
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { affiliate: { id: string; service_count: number; pending_invite_count: number } }
    expect(body.affiliate.service_count).toBe(2)
    expect(body.affiliate.pending_invite_count).toBe(2)

    const commissions = await env.DB.prepare(
      'SELECT count(*) as n FROM affiliate_commissions WHERE affiliate_company_id = ?',
    )
      .bind(body.affiliate.id)
      .first<{ n: number }>()
    expect(commissions!.n).toBe(2)

    const invites = await env.DB.prepare(
      'SELECT count(*) as n FROM affiliate_invitations WHERE affiliate_company_id = ? AND status = ?',
    )
      .bind(body.affiliate.id, 'pending')
      .first<{ n: number }>()
    expect(invites!.n).toBe(2)
  })

  it('D2 — enabling a service at a zero rate → 400 (Zod positive)', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const svc = await seedService({ organizationId })
    const res = await SELF.fetch(api(''), {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        company: { name: 'Hotel Maya' },
        commissions: [{ service_id: svc, commission_type: 'percent', commission_value: 0 }],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('D10 — fixed rate above the service minimum_price → 400', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const svc = await seedService({ organizationId, minimumPrice: 100000 })
    const res = await SELF.fetch(api(''), {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        company: { name: 'Hotel Maya' },
        commissions: [{ service_id: svc, commission_type: 'fixed', commission_value: 100001 }],
      }),
    })
    expect(res.status).toBe(400)
    // Atomic fail-all: no company persisted.
    const n = await env.DB.prepare('SELECT count(*) as n FROM affiliate_companies').first<{ n: number }>()
    expect(n!.n).toBe(0)
  })

  it('enabling an inactive service → 409 SERVICE_INACTIVE', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const svc = await seedService({ organizationId, status: 'inactive' })
    const res = await SELF.fetch(api(''), {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        company: { name: 'Hotel Maya' },
        commissions: [{ service_id: svc, commission_type: 'percent', commission_value: 1000 }],
      }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: { code?: string }; code?: string }
    expect(JSON.stringify(body)).toContain('SERVICE_INACTIVE')
  })

  it('non-admin (agent) → 403', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
    const res = await SELF.fetch(api(''), {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({ company: { name: 'X' } }),
    })
    expect(res.status).toBe(403)
  })
})

describe('US-A48/A50 — list / detail / edit / bulk commissions', () => {
  it('lists affiliates with service + user counts', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { companyId } = await seedAffiliateCompany({ organizationId, name: 'Hotel Maya' })
    const svc = await seedService({ organizationId })
    await env.DB.prepare(
      `INSERT INTO affiliate_commissions (id, organization_id, affiliate_company_id, service_id, commission_type, commission_value)
       VALUES (?, ?, ?, ?, 'percent', 1500)`,
    )
      .bind(crypto.randomUUID(), organizationId, companyId, svc)
      .run()
    await seedUser({ email: 'aff@maya.com', role: 'affiliate', organizationId, affiliateCompanyId: companyId })

    const res = await SELF.fetch(api(''), { headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { affiliates: Array<{ id: string; service_count: number; user_count: number }> }
    expect(body.affiliates).toHaveLength(1)
    expect(body.affiliates[0].service_count).toBe(1)
    expect(body.affiliates[0].user_count).toBe(1)
  })

  it('bulk upsert disables a service by omission (D1)', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { companyId } = await seedAffiliateCompany({ organizationId })
    const svc1 = await seedService({ organizationId, name: 'A' })
    const svc2 = await seedService({ organizationId, name: 'B' })
    // Start with both enabled.
    for (const s of [svc1, svc2]) {
      await env.DB.prepare(
        `INSERT INTO affiliate_commissions (id, organization_id, affiliate_company_id, service_id, commission_type, commission_value)
         VALUES (?, ?, ?, ?, 'percent', 1000)`,
      )
        .bind(crypto.randomUUID(), organizationId, companyId, s)
        .run()
    }

    const res = await SELF.fetch(api(`/${companyId}/commissions`), {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify([{ service_id: svc1, commission_type: 'percent', commission_value: 2000 }]),
    })
    expect(res.status).toBe(200)

    const rows = await env.DB.prepare(
      'SELECT service_id, commission_value FROM affiliate_commissions WHERE affiliate_company_id = ?',
    )
      .bind(companyId)
      .all<{ service_id: string; commission_value: number }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0].service_id).toBe(svc1)
    expect(rows.results[0].commission_value).toBe(2000)
  })

  it('edits company profile fields (D11)', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { companyId } = await seedAffiliateCompany({ organizationId, name: 'Old' })
    const res = await SELF.fetch(api(`/${companyId}`), {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'New Name', contact_phone: '+52 55 0000 0000' }),
    })
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT name, contact_phone FROM affiliate_companies WHERE id = ?')
      .bind(companyId)
      .first<{ name: string; contact_phone: string }>()
    expect(row!.name).toBe('New Name')
  })
})

describe('US-A49 — invite', () => {
  it('invites a login; a second pending invite for the same email → 409 ALREADY_INVITED', async () => {
    mockResend()
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { companyId } = await seedAffiliateCompany({ organizationId })

    const first = await SELF.fetch(api(`/${companyId}/invite`), {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ email: 'concierge@maya.com' }),
    })
    expect(first.status).toBe(201)

    const second = await SELF.fetch(api(`/${companyId}/invite`), {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ email: 'concierge@maya.com' }),
    })
    expect(second.status).toBe(409)
    expect(JSON.stringify(await second.json())).toContain('ALREADY_INVITED')
  })
})

describe('US-A52 — suspend / reactivate cascade', () => {
  it('suspending the company suspends its affiliate users; reactivating restores them', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { companyId } = await seedAffiliateCompany({ organizationId })
    const { userId } = await seedUser({
      email: 'aff@maya.com',
      role: 'affiliate',
      organizationId,
      affiliateCompanyId: companyId,
      status: 'active',
    })

    const off = await SELF.fetch(api(`/${companyId}/deactivate`), { method: 'POST', headers: auth(ADMIN_EMAIL) })
    expect(off.status).toBe(200)
    let row = await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first<{ status: string }>()
    expect(row!.status).toBe('suspended')
    const co = await env.DB.prepare('SELECT status FROM affiliate_companies WHERE id = ?').bind(companyId).first<{ status: string }>()
    expect(co!.status).toBe('suspended')

    const on = await SELF.fetch(api(`/${companyId}/reactivate`), { method: 'POST', headers: auth(ADMIN_EMAIL) })
    expect(on.status).toBe(200)
    row = await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first<{ status: string }>()
    expect(row!.status).toBe('active')
  })
})

describe('US-A53 — settlement report', () => {
  it('cash owed = cash collected − commission − confirmed deposits', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { companyId } = await seedAffiliateCompany({ organizationId })
    const { userId } = await seedUser({
      email: 'aff@maya.com',
      role: 'affiliate',
      organizationId,
      affiliateCompanyId: companyId,
    })
    const ts = Math.floor(Date.now() / 1000)
    // A cash sale: collected 100000, commission 15000.
    await env.DB.prepare(
      `INSERT INTO folios (id, organization_id, agent_id, affiliate_company_id, status, payment_method, subtotal, discount_total, total, amount_paid, commission_amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paid', 'cash', 100000, 0, 100000, 100000, 15000, ?, ?)`,
    )
      .bind(crypto.randomUUID(), organizationId, userId, companyId, ts, ts)
      .run()
    // A confirmed deposit of 50000 handed in by the affiliate user.
    await env.DB.prepare(
      `INSERT INTO cash_drops (id, organization_id, agent_id, amount, balance_before, status, source, created_at, updated_at)
       VALUES (?, ?, ?, 50000, 100000, 'confirmed', 'agent', ?, ?)`,
    )
      .bind(crypto.randomUUID(), organizationId, userId, ts, ts)
      .run()

    const res = await SELF.fetch(api(`/${companyId}/report`), { headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { report: { cash_collected: number; commission_total: number; deposits_total: number; cash_owed: number } }
    expect(body.report.cash_collected).toBe(100000)
    expect(body.report.commission_total).toBe(15000)
    expect(body.report.deposits_total).toBe(50000)
    expect(body.report.cash_owed).toBe(35000)
  })
})

describe('Multitenancy isolation (B1/B3/B4 + cross-org service enable)', () => {
  it('B4 — list never returns another org\'s affiliates', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedAffiliateCompany({ organizationId: orgA.organizationId, name: 'A-Hotel' })
    await seedAffiliateCompany({ organizationId: orgB.organizationId, name: 'B-Hotel' })

    const res = await SELF.fetch(api(''), { headers: auth(orgB.adminEmail) })
    const body = (await res.json()) as { affiliates: Array<{ name: string }> }
    expect(body.affiliates.map((a) => a.name)).toEqual(['B-Hotel'])
  })

  it('B3 — acting on another org\'s affiliate id → 404', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { companyId } = await seedAffiliateCompany({ organizationId: orgA.organizationId })
    const res = await SELF.fetch(api(`/${companyId}`), { headers: auth(orgB.adminEmail) })
    expect(res.status).toBe(404)
  })

  it('B1 — injected organization_id in body is ignored; row stays in caller org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const res = await SELF.fetch(api(''), {
      method: 'POST',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({ company: { name: 'Maya' }, organization_id: orgB.organizationId }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { affiliate: { id: string } }
    const row = await env.DB.prepare('SELECT organization_id FROM affiliate_companies WHERE id = ?')
      .bind(body.affiliate.id)
      .first<{ organization_id: string }>()
    expect(row!.organization_id).toBe(orgA.organizationId)
  })

  it('cross-org service enable → 404 (service belongs to another org)', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const orgBService = await seedService({ organizationId: orgB.organizationId })
    const res = await SELF.fetch(api(''), {
      method: 'POST',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        company: { name: 'Maya' },
        commissions: [{ service_id: orgBService, commission_type: 'percent', commission_value: 1000 }],
      }),
    })
    expect(res.status).toBe(404)
  })
})
