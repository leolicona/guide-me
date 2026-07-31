import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Express Sale — US-AG45 (express confirm: payload rules, eligibility, idempotency) and
// US-AG47 (the 60-second void: full ledger reversal, no ladder).
// Spec: docs/pos/express-sale.spec.md (S-5..S-9, S-11..S-14, S-22).

const AGENT_EMAIL = 'agent@empresa.com'
const OTHER_AGENT_EMAIL = 'agent2@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/pos'

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (
  organizationId: string,
  opts: { commissionValue?: number; zonesEnabled?: boolean } = {},
): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, zones_enabled, status, created_at, updated_at)
     VALUES (?, ?, 'Tour Cañón', NULL, 150000, 100000, 12, 'percent', ?, ?, 'active', ?, ?)`,
  )
    .bind(id, organizationId, opts.commissionValue ?? 0, opts.zonesEnabled ? 1 : 0, ts, ts)
    .run()
  return id
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  daysOut = 3,
  booked = 0,
): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '10:00', 12, ?, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, addDays(todayStr(), daysOut), booked, ts, ts)
    .run()
  return id
}

interface ExpressOverrides {
  [key: string]: unknown
}
const expressConfirm = async (email: string, slotId: string, overrides: ExpressOverrides = {}) => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      sale_mode: 'express',
      customer_phone: PHONE,
      payment_method: 'cash',
      lines: [{ slot_id: slotId, quantity: 4, unit_price: 150000 }],
      ...overrides,
    }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const voidFolio = async (email: string, id: string) => {
  const res = await SELF.fetch(`${base}/folios/${id}/void`, {
    method: 'POST',
    headers: jsonAuth(email),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const getFolioRow = (id: string) =>
  env.DB.prepare(
    `SELECT status, sale_mode, customer_name, amount_paid, commission_amount, refund_status,
            refund_amount, refund_pin, refunded_at, cancellation_source
     FROM folios WHERE id = ?`,
  )
    .bind(id)
    .first<any>()

const getSlotBooked = async (id: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(id).first<{ booked: number }>())!
    .booked

// Signed ledger rows net to what the folio still contributes to the books (see paid-ledger).
const ledgerNet = async (folioId: string): Promise<{ money: number; commission: number }> => {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN entry_type IN ('payment','refund') THEN amount END), 0) AS money,
       COALESCE(SUM(CASE WHEN entry_type IN ('commission','commission_reversal') THEN amount END), 0) AS commission
     FROM folio_payments WHERE folio_id = ?`,
  )
    .bind(folioId)
    .first<{ money: number; commission: number }>()
  return { money: Number(row!.money), commission: Number(row!.commission) }
}

const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-AG45 — the express confirm', () => {
  it('S-5 — a sale closes with phone only (no name), cash in full', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId, { commissionValue: 1000 })
    const slotId = await seedSlot(organizationId, serviceId)

    const { status, json } = await expressConfirm(AGENT_EMAIL, slotId)
    expect(status, JSON.stringify(json)).toBe(201)
    expect(json.folio.status).toBe('paid')
    expect(json.folio.customer_name).toBeNull()
    expect(json.folio.amount_paid).toBe(600000) // 4 × 150000, full payment

    const row = await getFolioRow(json.folio.id)
    expect(row.sale_mode).toBe('express')
    expect(row.customer_name).toBeNull()
    // One cash payment row + one commission row (10% of 600000).
    const net = await ledgerNet(json.folio.id)
    expect(net.money).toBe(600000)
    expect(net.commission).toBe(60000)
    expect(await getSlotBooked(slotId)).toBe(4)
  })

  it('S-6 — a standard sale still requires a name (the exemption does not leak)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)

    const res = await SELF.fetch(`${base}/folios`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({
        customer_phone: PHONE,
        lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('S-7 — the snapshot price floor and ceiling still apply', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)

    const below = await expressConfirm(AGENT_EMAIL, slotId, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 99999 }],
    })
    expect(below.status).toBe(400)
    expect(below.json.error.code).toBe('PRICE_BELOW_MINIMUM')

    const above = await expressConfirm(AGENT_EMAIL, slotId, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150001 }],
    })
    expect(above.status).toBe(400)
  })

  it('S-8 — a replayed idempotency key returns the same folio and sells nothing twice', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId, { commissionValue: 1000 })
    const slotId = await seedSlot(organizationId, serviceId)

    const key = crypto.randomUUID()
    const first = await expressConfirm(AGENT_EMAIL, slotId, { idempotency_key: key })
    expect(first.status, JSON.stringify(first.json)).toBe(201)

    const second = await expressConfirm(AGENT_EMAIL, slotId, { idempotency_key: key })
    expect(second.status).toBe(200)
    expect(second.json.replayed).toBe(true)
    expect(second.json.folio.id).toBe(first.json.folio.id)

    // The replay decremented nothing and ledgered nothing.
    expect(await getSlotBooked(slotId)).toBe(4)
    const payments = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM folio_payments WHERE folio_id = ? AND entry_type = 'payment'`,
    )
      .bind(first.json.folio.id)
      .first<{ n: number }>()
    expect(Number(payments!.n)).toBe(1)
  })

  it('S-9 — payload guards: two lines / extras / down_payment / non-cash are each refused', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const slotId2 = await seedSlot(organizationId, serviceId, 4)

    const cases: ExpressOverrides[] = [
      {
        lines: [
          { slot_id: slotId, quantity: 1, unit_price: 150000 },
          { slot_id: slotId2, quantity: 1, unit_price: 150000 },
        ],
      },
      { down_payment: 10000 },
      { payment_method: 'transfer', payment_reference: 'REF-1234' },
    ]
    for (const overrides of cases) {
      const { status, json } = await expressConfirm(AGENT_EMAIL, slotId, overrides)
      expect(status, JSON.stringify(json)).toBe(422)
      expect(json.error.code).toBe('EXPRESS_PAYLOAD_INVALID')
      const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM folios`).first<{ n: number }>()
      expect(Number(count!.n)).toBe(0)
    }
  })

  it('rule 3 — a zoned service is not eligible', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId, { zonesEnabled: true })
    const slotId = await seedSlot(organizationId, serviceId)

    const { status, json } = await expressConfirm(AGENT_EMAIL, slotId)
    expect(status).toBe(422)
    expect(json.error.code).toBe('EXPRESS_NOT_ELIGIBLE')
  })
})

describe('US-AG47 — the 60-second void', () => {
  it('S-11 — a mis-tap is undone: seats back, ledger reversed, refund settled, NO pin', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId, { commissionValue: 1000 })
    const slotId = await seedSlot(organizationId, serviceId)

    const sale = await expressConfirm(AGENT_EMAIL, slotId)
    expect(sale.status).toBe(201)

    const { status, json } = await voidFolio(AGENT_EMAIL, sale.json.folio.id)
    expect(status, JSON.stringify(json)).toBe(200)
    expect(json.status).toBe('cancelled')
    expect(json.refund_amount).toBe(600000)
    expect(json.released_seats).toBe(4)

    expect(await getSlotBooked(slotId)).toBe(0)
    const row = await getFolioRow(sale.json.folio.id)
    expect(row.status).toBe('cancelled')
    expect(row.cancellation_source).toBe('agent')
    expect(row.refund_status).toBe('refunded')
    expect(row.refund_amount).toBe(600000)
    expect(row.refunded_at).not.toBeNull()
    expect(row.refund_pin).toBeNull() // D15 — no PIN for cash handed straight back
  })

  it('S-12 — the void nets the ledger (and so the caja) to zero', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId, { commissionValue: 1000 })
    const slotId = await seedSlot(organizationId, serviceId)

    const sale = await expressConfirm(AGENT_EMAIL, slotId)
    await voidFolio(AGENT_EMAIL, sale.json.folio.id)

    const net = await ledgerNet(sale.json.folio.id)
    expect(net.money).toBe(0)
    expect(net.commission).toBe(0)
  })

  it('S-13 — the cancellation ladder is never consulted (full refund under a 100%-retention policy)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    // A terminal-only ladder that retains EVERYTHING — a priced cancellation would refund 0.
    await env.DB.prepare(
      `UPDATE organizations SET cancellation_policy = ? WHERE id = ?`,
    )
      .bind(
        JSON.stringify({
          version: 1,
          tiers: [{ min_hours: null, refund_pct: 0, agent_commission_pct: 100 }],
        }),
        organizationId,
      )
      .run()
    const serviceId = await seedService(organizationId, { commissionValue: 1000 })
    const slotId = await seedSlot(organizationId, serviceId)

    const sale = await expressConfirm(AGENT_EMAIL, slotId)
    const { status, json } = await voidFolio(AGENT_EMAIL, sale.json.folio.id)
    expect(status).toBe(200)
    expect(json.refund_amount).toBe(600000) // the ladder would have said 0
    const net = await ledgerNet(sale.json.folio.id)
    expect(net.commission).toBe(0) // the ladder would have kept it
  })

  it('S-14 — every guard closes the window with 409 VOID_WINDOW_CLOSED', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await seedUser({ email: OTHER_AGENT_EMAIL, role: 'agent', organizationId })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)

    // (a) a different same-org seller
    const sale = await expressConfirm(AGENT_EMAIL, slotId)
    const other = await voidFolio(OTHER_AGENT_EMAIL, sale.json.folio.id)
    expect(other.status).toBe(409)
    expect(other.json.error.code).toBe('VOID_WINDOW_CLOSED')

    // (b) 61 s elapsed — backdate created_at
    await env.DB.prepare(
      `UPDATE folios SET created_at = created_at - 61 WHERE id = ?`,
    )
      .bind(sale.json.folio.id)
      .run()
    const late = await voidFolio(AGENT_EMAIL, sale.json.folio.id)
    expect(late.status).toBe(409)

    // (c) delivered (tickets_viewed_at set)
    const sale2 = await expressConfirm(AGENT_EMAIL, slotId, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    await env.DB.prepare(
      `UPDATE folios SET tickets_viewed_at = unixepoch() WHERE id = ?`,
    )
      .bind(sale2.json.folio.id)
      .run()
    const delivered = await voidFolio(AGENT_EMAIL, sale2.json.folio.id)
    expect(delivered.status).toBe(409)

    // (d) a scanned pass
    const sale3 = await expressConfirm(AGENT_EMAIL, slotId, {
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })
    await env.DB.prepare(
      `UPDATE folio_lines SET redeemed_count = 1 WHERE folio_id = ?`,
    )
      .bind(sale3.json.folio.id)
      .run()
    const scanned = await voidFolio(AGENT_EMAIL, sale3.json.folio.id)
    expect(scanned.status).toBe(409)

    // (e) a standard sale
    const std = await SELF.fetch(`${base}/folios`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({
        customer_name: 'Cliente Test',
        customer_phone: PHONE,
        lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
      }),
    })
    const stdJson = (await std.json()) as any
    expect(std.status).toBe(201)
    const stdVoid = await voidFolio(AGENT_EMAIL, stdJson.folio.id)
    expect(stdVoid.status).toBe(409)

    // Nothing was written by any refused void.
    for (const id of [sale.json.folio.id, sale2.json.folio.id, sale3.json.folio.id, stdJson.folio.id]) {
      const row = await getFolioRow(id)
      expect(row.status).toBe('paid')
    }
  })

  it('S-22 — another org\'s folio cannot be voided (404, never 403)', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceId = await seedService(orgA.organizationId)
    const slotId = await seedSlot(orgA.organizationId, serviceId)
    // orgA needs an agent seller (seedTwoOrgs seeds admins).
    await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      organizationId: orgA.organizationId,
    })
    const sale = await expressConfirm(AGENT_EMAIL, slotId)
    expect(sale.status).toBe(201)

    const foreign = await SELF.fetch(`${base}/folios/${sale.json.folio.id}/void`, {
      method: 'POST',
      headers: jsonAuth(orgB.adminEmail),
    })
    expect(foreign.status).toBe(404)
  })
})
