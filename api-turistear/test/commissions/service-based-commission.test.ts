import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Service-Based Commission — US-A12 (rev.), US-AG23, US-A33.
// Spec: docs/commissions/service-based-commission.spec.md (Scenarios S1–S7).
//
// Commission belongs to the SERVICE (`commission_type` percent|fixed + `commission_value`),
// not the seller: agent and admin earn identically for identical carts, with no seller-rate
// lookup. percent → basis points of the line total INCLUDING extras (post-discount); fixed →
// minor units PER SPOT (× quantity), ignoring discounts/extras, capped at minimum_price by
// catalog validation (D3). Snapshot semantics unchanged: the amount is stored on the folio at
// confirm and never rewritten. Catalog validation scenarios live in
// test/catalog/service-catalog.test.ts; cross-org isolation in the catalog/POS suites.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const POS = 'http://api.local/api/pos'

// --- Local seeders (raw D1) ------------------------------------------------

const seedService = async (
  organizationId: string,
  opts: {
    commissionType?: 'percent' | 'fixed'
    commissionValue?: number
    basePrice?: number
    minimumPrice?: number
  } = {},
): Promise<string> => {
  const {
    commissionType = 'percent',
    commissionValue = 0,
    basePrice = 150000,
    minimumPrice = 100000,
  } = opts
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Canyon Tour', NULL, ?, ?, 12, ?, ?, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, basePrice, minimumPrice, commissionType, commissionValue, ts, ts)
    .run()
  return serviceId
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  startTime = '06:00', // (org, service, date, start_time) is UNIQUE — vary per slot
): Promise<string> => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, '2026-06-15', ?, 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, startTime, ts, ts)
    .run()
  return slotId
}

const seedExtra = async (organizationId: string, serviceId: string, price: number) => {
  const extraId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO service_extras
       (id, organization_id, service_id, name, price, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Photo', ?, 'active', ?, ?)`,
  )
    .bind(extraId, organizationId, serviceId, price, ts, ts)
    .run()
  return extraId
}

const confirmSale = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ customer_email: 'cliente@example.com', ...body }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const seedOrgWithStaff = async () => {
  const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  return { organizationId }
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM cancellation_requests')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('Service-Based Commission (US-A12 rev.)', () => {
  it('S1 — a percent service pays agent and admin identically (seller-independent)', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId, { commissionValue: 1000 }) // 10%

    const agentSale = await confirmSale(AGENT_EMAIL, {
      lines: [{ slot_id: await seedSlot(organizationId, serviceId, '06:00'), quantity: 2, unit_price: 150000 }],
    })
    const adminSale = await confirmSale(ADMIN_EMAIL, {
      lines: [{ slot_id: await seedSlot(organizationId, serviceId, '09:00'), quantity: 2, unit_price: 150000 }],
    })

    // 300000 × 10% = 30000, for either seller — byte-identical snapshots.
    expect(agentSale.status).toBe(201)
    expect(adminSale.status).toBe(201)
    expect(agentSale.json.folio.commission_amount).toBe(30000)
    expect(adminSale.json.folio.commission_amount).toBe(30000)
  })

  it('S2 — a fixed service pays per spot (× quantity)', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId, {
      commissionType: 'fixed',
      commissionValue: 30000, // $300.00 per spot, ≤ minimum_price 100000
    })
    const slotId = await seedSlot(organizationId, serviceId)

    const { status, json } = await confirmSale(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 4, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(json.folio.commission_amount).toBe(120000) // 30000 × 4
  })

  it('S3 — percent includes extras; fixed ignores them (D4)', async () => {
    const { organizationId } = await seedOrgWithStaff()

    // Percent: line 150000 + extra 50000 → 10% of 200000 = 20000.
    const pctService = await seedService(organizationId, { commissionValue: 1000 })
    const pctExtra = await seedExtra(organizationId, pctService, 50000)
    const pctSale = await confirmSale(AGENT_EMAIL, {
      lines: [
        {
          slot_id: await seedSlot(organizationId, pctService),
          quantity: 1,
          unit_price: 150000,
          extras: [{ extra_id: pctExtra, quantity: 1 }],
        },
      ],
    })
    expect(pctSale.status).toBe(201)
    expect(pctSale.json.folio.commission_amount).toBe(20000)

    // Fixed: the same cart shape on a fixed-30000 service pays exactly 30000 — the extra moves
    // the folio total but never the commission.
    const fixService = await seedService(organizationId, {
      commissionType: 'fixed',
      commissionValue: 30000,
    })
    const fixExtra = await seedExtra(organizationId, fixService, 50000)
    const fixSale = await confirmSale(AGENT_EMAIL, {
      lines: [
        {
          slot_id: await seedSlot(organizationId, fixService),
          quantity: 1,
          unit_price: 150000,
          extras: [{ extra_id: fixExtra, quantity: 1 }],
        },
      ],
    })
    expect(fixSale.status).toBe(201)
    expect(fixSale.json.folio.total).toBe(200000)
    expect(fixSale.json.folio.commission_amount).toBe(30000)
  })

  it('S5 — the snapshot is immune to later catalog edits', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId, { commissionValue: 1000 }) // 10%
    const slotId = await seedSlot(organizationId, serviceId)

    const sale = await confirmSale(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(sale.json.folio.commission_amount).toBe(15000)

    // Re-type the commission after the sale (10% → fixed 50000).
    await env.DB.prepare(
      `UPDATE services SET commission_type = 'fixed', commission_value = 50000 WHERE id = ?`,
    )
      .bind(serviceId)
      .run()

    const row = await env.DB.prepare(`SELECT commission_amount FROM folios WHERE id = ?`)
      .bind(sale.json.folio.id)
      .first<{ commission_amount: number }>()
    expect(row?.commission_amount).toBe(15000) // unchanged

    // …and only NEW sales use the new rule.
    const after = await confirmSale(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(after.json.folio.commission_amount).toBe(50000)
  })

  it('S7 — discount interaction: percent shrinks with the price; fixed holds at the floor (D3)', async () => {
    const { organizationId } = await seedOrgWithStaff()

    // Percent at the discounted floor: 100000 × 10% = 10000.
    const pctService = await seedService(organizationId, { commissionValue: 1000 })
    const pctSale = await confirmSale(AGENT_EMAIL, {
      lines: [{ slot_id: await seedSlot(organizationId, pctService), quantity: 1, unit_price: 100000 }],
    })
    expect(pctSale.json.folio.commission_amount).toBe(10000)

    // Fixed at the floor still pays its full per-spot value — safe only because the catalog
    // caps it at minimum_price, so commission never exceeds what the pass collected.
    const fixService = await seedService(organizationId, {
      commissionType: 'fixed',
      commissionValue: 30000,
    })
    const fixSale = await confirmSale(AGENT_EMAIL, {
      lines: [{ slot_id: await seedSlot(organizationId, fixService), quantity: 1, unit_price: 100000 }],
    })
    expect(fixSale.status).toBe(201)
    expect(fixSale.json.folio.commission_amount).toBe(30000)
  })
})
