import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import {
  seedUser,
  seedTwoOrgs,
  seedAffiliateCompany,
  seedAffiliateCommission,
  clearAffiliateDb,
} from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Affiliate Reseller Portal. Spec: docs/affiliates/affiliate-portal.spec.md.
// The affiliate is a scoped-down agent: curated catalog (allow-list), commission from the
// per-affiliate rate, no scanner / no expenses. Clock is frozen at 2026-06-14; slots at
// 2026-06-15 are sellable.

const ADMIN_EMAIL = 'admin@empresa.com'
const AFF_EMAIL = 'aff@maya.com'
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

const mockAgnosticAuth = (identity: string) => {
  vi.spyOn(env.AGNOSTIC_AUTH_API, 'fetch').mockImplementation(async () => {
    return new Response(
      JSON.stringify({
        success: true,
        data: { jwt: buildFakeJwt(identity), refreshToken: 'fresh', hash: 'H', salt: 'S' },
      }),
      { status: 200 },
    )
  })
}

const seedService = async ({
  organizationId,
  name = 'City Tour',
  basePrice = 150000,
  minimumPrice = 100000,
  commissionType = 'percent',
  commissionValue = 0,
}: {
  organizationId: string
  name?: string
  basePrice?: number
  minimumPrice?: number
  commissionType?: 'percent' | 'fixed'
  commissionValue?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(id, organizationId, name, basePrice, minimumPrice, 12, commissionType, commissionValue, ts, ts)
    .run()
  return id
}

const seedSlot = async (organizationId: string, serviceId: string, date = '2026-06-15') => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '10:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, date, ts, ts)
    .run()
  return id
}

/** Standard fixture: an org with an admin, an affiliate company + linked affiliate user, one
 *  enabled service (allow-list) and one NOT enabled. Returns the ids. */
const seedPortalFixture = async () => {
  const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const { companyId } = await seedAffiliateCompany({ organizationId })
  await seedUser({ email: AFF_EMAIL, role: 'affiliate', organizationId, affiliateCompanyId: companyId })
  const enabled = await seedService({ organizationId, name: 'Enabled Tour' })
  const hidden = await seedService({ organizationId, name: 'Hidden Tour' })
  await seedAffiliateCommission({
    organizationId,
    affiliateCompanyId: companyId,
    serviceId: enabled,
    commissionType: 'percent',
    commissionValue: 2000, // 20%
  })
  return { organizationId, companyId, enabled, hidden }
}

beforeEach(clearAffiliateDb)
afterEach(() => vi.restoreAllMocks())

describe('AF04 — curated catalog', () => {
  it('GET /api/pos/services returns only allow-list services for an affiliate', async () => {
    const { enabled } = await seedPortalFixture()
    const res = await SELF.fetch('http://api.local/api/pos/services', { headers: auth(AFF_EMAIL) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { services: Array<{ id: string; name: string }> }
    expect(body.services.map((s) => s.id)).toEqual([enabled])
  })

  it('an agent in the same org still sees the full catalog (no filter)', async () => {
    const { organizationId } = await seedPortalFixture()
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
    const res = await SELF.fetch('http://api.local/api/pos/services', { headers: auth(AGENT_EMAIL) })
    const body = (await res.json()) as { services: unknown[] }
    expect(body.services).toHaveLength(2)
  })

  it('GET /api/pos/services/:id for a non-allow-list service → 404', async () => {
    const { hidden } = await seedPortalFixture()
    const res = await SELF.fetch(`http://api.local/api/pos/services/${hidden}`, { headers: auth(AFF_EMAIL) })
    expect(res.status).toBe(404)
  })

  it('GET /api/pos/services/:id for an allow-list service → 200', async () => {
    const { enabled } = await seedPortalFixture()
    const res = await SELF.fetch(`http://api.local/api/pos/services/${enabled}`, { headers: auth(AFF_EMAIL) })
    expect(res.status).toBe(200)
  })
})

describe('AF04/AF06 — checkout: guard, commission source, discount floor', () => {
  it('selling a non-allow-list service → 403 SERVICE_NOT_ALLOWED', async () => {
    const { organizationId, hidden } = await seedPortalFixture()
    const slot = await seedSlot(organizationId, hidden)
    const res = await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(AFF_EMAIL),
      body: JSON.stringify({ lines: [{ slot_id: slot, quantity: 1, unit_price: 150000 }] }),
    })
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).toContain('SERVICE_NOT_ALLOWED')
  })

  it('an affiliate sale snapshots the per-affiliate commission (20%), not services.commission_*', async () => {
    mockResend()
    const { organizationId, companyId, enabled } = await seedPortalFixture()
    const slot = await seedSlot(organizationId, enabled)
    const res = await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(AFF_EMAIL),
      body: JSON.stringify({ lines: [{ slot_id: slot, quantity: 1, unit_price: 150000 }] }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { folio: { id: string; commission_amount: number } }
    // 20% of 150000 = 30000 (the affiliate rate), even though the service's own rate is 0.
    expect(body.folio.commission_amount).toBe(30000)

    const folioRow = await env.DB.prepare(
      'SELECT affiliate_company_id FROM folios WHERE id = ?',
    )
      .bind(body.folio.id)
      .first<{ affiliate_company_id: string }>()
    expect(folioRow!.affiliate_company_id).toBe(companyId)

    const lineRow = await env.DB.prepare(
      'SELECT commission_type, commission_value FROM folio_lines WHERE folio_id = ?',
    )
      .bind(body.folio.id)
      .first<{ commission_type: string; commission_value: number }>()
    expect(lineRow!.commission_type).toBe('percent')
    expect(lineRow!.commission_value).toBe(2000)
  })

  it('an agent sale leaves affiliate_company_id null and uses the service rate', async () => {
    mockResend()
    const { organizationId } = await seedPortalFixture()
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
    const svc = await seedService({ organizationId, name: 'Agent Tour', commissionValue: 1000 })
    const slot = await seedSlot(organizationId, svc)
    const res = await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({
        customer_email: 'tourist@example.com',
        lines: [{ slot_id: slot, quantity: 1, unit_price: 150000 }],
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { folio: { id: string; commission_amount: number } }
    expect(body.folio.commission_amount).toBe(15000) // 10% service rate
    const row = await env.DB.prepare('SELECT affiliate_company_id FROM folios WHERE id = ?')
      .bind(body.folio.id)
      .first<{ affiliate_company_id: string | null }>()
    expect(row!.affiliate_company_id).toBeNull()
  })

  it('AF06 — discount below minimum_price is blocked for an affiliate (same as an agent)', async () => {
    const { organizationId, enabled } = await seedPortalFixture()
    const slot = await seedSlot(organizationId, enabled)
    const res = await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(AFF_EMAIL),
      body: JSON.stringify({ lines: [{ slot_id: slot, quantity: 1, unit_price: 90000 }] }),
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('PRICE_BELOW_MINIMUM')
  })
})

describe('D4 — capability denials', () => {
  it('an affiliate calling the scanner → 403', async () => {
    await seedPortalFixture()
    const res = await SELF.fetch('http://api.local/api/tickets/scan', {
      method: 'POST',
      headers: jsonAuth(AFF_EMAIL),
      body: JSON.stringify({ token: 'whatever' }),
    })
    expect(res.status).toBe(403)
  })

  it('an affiliate adding an expense → 403', async () => {
    await seedPortalFixture()
    const res = await SELF.fetch('http://api.local/api/cash/me/expenses', {
      method: 'POST',
      headers: jsonAuth(AFF_EMAIL),
      body: JSON.stringify({ description: 'gas', amount: 5000 }),
    })
    expect(res.status).toBe(403)
  })

  it('an affiliate CAN read their own cash balance (parity, D5)', async () => {
    await seedPortalFixture()
    const res = await SELF.fetch('http://api.local/api/cash/me', { headers: auth(AFF_EMAIL) })
    expect(res.status).toBe(200)
  })
})

// The admin's Caja folds affiliates into the SAME roster as agents (architecture review):
// no standalone affiliate report — they appear as another cash-holding row, tagged with
// their role + company, and the admin settles them through the existing collection flow.
describe('Admin Caja folds in affiliates (D5/D6)', () => {
  const affUserId = () =>
    env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(AFF_EMAIL).first<{ id: string }>()

  it('GET /api/cash/balances includes the affiliate, tagged with role + company', async () => {
    mockResend()
    const { organizationId, enabled } = await seedPortalFixture()
    // The affiliate sells a cash pass → they now hold company cash (a balance row).
    const slot = await seedSlot(organizationId, enabled)
    await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(AFF_EMAIL),
      body: JSON.stringify({ lines: [{ slot_id: slot, quantity: 1, unit_price: 150000 }] }),
    })

    const res = await SELF.fetch('http://api.local/api/cash/balances', { headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      balances: Array<{ agent: { id: string }; role: string; affiliate_company: string | null; balance: number }>
    }
    const aff = body.balances.find((r) => r.role === 'affiliate')
    expect(aff).toBeDefined()
    expect(aff!.affiliate_company).toBe('Hotel Maya')
    // 150000 collected − 30000 commission (20%) = 120000 held.
    expect(aff!.balance).toBe(120000)
  })

  it('an admin can register a direct collection against an affiliate', async () => {
    mockResend()
    const { organizationId, enabled } = await seedPortalFixture()
    const slot = await seedSlot(organizationId, enabled)
    const sale = await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(AFF_EMAIL),
      body: JSON.stringify({ lines: [{ slot_id: slot, quantity: 1, unit_price: 150000 }] }),
    })
    const saleBody = (await sale.json()) as { folio: { id: string } }
    // Backdate the sale so it sits clearly before the collection watermark (avoids the
    // same-second collision that would re-count it into the post-watermark shift).
    await env.DB.prepare('UPDATE folios SET created_at = ? WHERE id = ?')
      .bind(Math.floor(Date.now() / 1000) - 100, saleBody.folio.id)
      .run()
    const aff = await affUserId()

    const res = await SELF.fetch('http://api.local/api/cash/collections', {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ agent_id: aff!.id, amount: 120000 }),
    })
    expect(res.status).toBe(201)

    // The affiliate's balance is now settled to zero.
    const me = await SELF.fetch('http://api.local/api/cash/me', { headers: auth(AFF_EMAIL) })
    const meBody = (await me.json()) as { balance: { balance: number } }
    expect(meBody.balance.balance).toBe(0)
  })
})

describe('AF01 — onboarding (parallel invite acceptance)', () => {
  it('accepting an affiliate invite creates an affiliate user linked to the company, with position', async () => {
    mockResend()
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { companyId } = await seedAffiliateCompany({ organizationId, name: 'Hotel Maya' })
    // Seed an affiliate invitation directly.
    const token = 'aff_token_xyz'
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
    const adminRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(ADMIN_EMAIL).first<{ id: string }>()
    await env.DB.prepare(
      `INSERT INTO affiliate_invitations (id, organization_id, affiliate_company_id, identity, identity_type, token, invited_by, status, expires_at)
       VALUES (?, ?, ?, ?, 'email', ?, ?, 'pending', ?)`,
    )
      .bind(crypto.randomUUID(), organizationId, companyId, 'concierge@maya.com', token, adminRow!.id, expiresAt)
      .run()

    // GET acceptance details — surfaces the company name read-only + the affiliate discriminator.
    const getRes = await SELF.fetch(`http://api.local/api/auth/invite/accept?token=${token}`)
    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as { invitation: { invitation_type: string; company_name: string } }
    expect(getBody.invitation.invitation_type).toBe('affiliate')
    expect(getBody.invitation.company_name).toBe('Hotel Maya')

    // POST complete — creates the affiliate user.
    mockAgnosticAuth('concierge@maya.com')
    const postRes = await SELF.fetch('http://api.local/api/auth/invite/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name: 'Ana Concierge', password: 'password123', position: 'Front Desk' }),
    })
    expect(postRes.status).toBe(200)
    const postBody = (await postRes.json()) as { user: { role: string } }
    expect(postBody.user.role).toBe('affiliate')

    const userRow = await env.DB.prepare(
      'SELECT role, affiliate_company_id, position FROM users WHERE email = ?',
    )
      .bind('concierge@maya.com')
      .first<{ role: string; affiliate_company_id: string; position: string }>()
    expect(userRow!.role).toBe('affiliate')
    expect(userRow!.affiliate_company_id).toBe(companyId)
    expect(userRow!.position).toBe('Front Desk')

    const inviteRow = await env.DB.prepare('SELECT status FROM affiliate_invitations WHERE token = ?')
      .bind(token)
      .first<{ status: string }>()
    expect(inviteRow!.status).toBe('accepted')
  })
})

describe('Multitenancy + cross-affiliate isolation', () => {
  it('an affiliate cannot sell an org_b service (its slot resolves to NOT_FOUND)', async () => {
    const { orgB } = await seedTwoOrgs()
    // org_a affiliate
    const { organizationId: orgA } = await seedUser({ email: ADMIN_EMAIL, role: 'admin', organizationName: 'A2' })
    const { companyId } = await seedAffiliateCompany({ organizationId: orgA })
    await seedUser({ email: AFF_EMAIL, role: 'affiliate', organizationId: orgA, affiliateCompanyId: companyId })
    // org_b service + slot
    const bSvc = await seedService({ organizationId: orgB.organizationId, name: 'B service' })
    const bSlot = await seedSlot(orgB.organizationId, bSvc)

    const res = await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(AFF_EMAIL),
      body: JSON.stringify({ lines: [{ slot_id: bSlot, quantity: 1, unit_price: 150000 }] }),
    })
    expect(res.status).toBe(404)
  })

  it('an affiliate only sees their OWN folios (caller-scoped by agent_id)', async () => {
    mockResend()
    const { organizationId, enabled } = await seedPortalFixture()
    // A folio by the admin (different agent_id) must not show up for the affiliate.
    const adminRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(ADMIN_EMAIL).first<{ id: string }>()
    const ts = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `INSERT INTO folios (id, organization_id, agent_id, status, payment_method, subtotal, discount_total, total, amount_paid, commission_amount, created_at, updated_at)
       VALUES (?, ?, ?, 'paid', 'cash', 150000, 0, 150000, 150000, 0, ?, ?)`,
    )
      .bind(crypto.randomUUID(), organizationId, adminRow!.id, ts, ts)
      .run()
    // An affiliate sale of their own.
    const slot = await seedSlot(organizationId, enabled)
    await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(AFF_EMAIL),
      body: JSON.stringify({ lines: [{ slot_id: slot, quantity: 1, unit_price: 150000 }] }),
    })

    const res = await SELF.fetch('http://api.local/api/pos/folios', { headers: auth(AFF_EMAIL) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { folios: unknown[] }
    expect(body.folios).toHaveLength(1)
  })
})
