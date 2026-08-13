import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import {
  materializeSeededFolio,
  seedFolioLedgerRows,
  seedTwoOrgs,
  seedUser,
  clearAffiliateDb,
} from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A14/A15/A16/A90 — the Daily Operations Dashboard read.
// Spec: docs/dashboard/occupancy-dashboard.spec.md — S-1 … S-12.
//
// The traffic-light thresholds (D11) are client-side arithmetic over the returned numbers, so what
// is asserted HERE is the numbers themselves: the chronological occupancy rows with the
// vendidos/apartados split from the lines' own money state, the departed section that exists only
// for the org's today, the day's money read from the LEDGER's dates (never the folio's), and that
// one org's day never leaks into another's.

const ADMIN = 'admin@empresa.com'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const DAY_URL = 'http://api.local/api/dashboard/day'

const nowSec = () => Math.floor(Date.now() / 1000)
const HOUR = 3600
const DAY = 86400
// The suite clock is frozen at 2026-06-14T12:00:00Z (helpers/apply-migrations.ts); seeded orgs
// are UTC, so today's wall clock IS the UTC clock: 07:00 has departed, 15:00 has not.
const TODAY = '2026-06-14'
const TOMORROW = '2026-06-15'

const seedService = async (
  organizationId: string,
  opts: { name?: string; isFlexible?: boolean; flexPct?: number } = {},
): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price,
       default_capacity, status, is_flexible, flex_capacity_pct, created_at, updated_at)
     VALUES (?, ?, ?, '', 100000, 80000, 20, 'active', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      opts.name ?? 'Tour Isla Mujeres',
      opts.isFlexible ? 1 : 0,
      opts.flexPct ?? 0,
      nowSec(),
      nowSec(),
    )
    .run()
  return id
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  startTime: string,
  opts: { capacity?: number; booked?: number; date?: string; status?: string } = {},
): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      serviceId,
      opts.date ?? TODAY,
      startTime,
      opts.capacity ?? 20,
      opts.booked ?? 0,
      opts.status ?? 'active',
      nowSec(),
      nowSec(),
    )
    .run()
  return id
}

// A folio holding one line on the given slot. `state: 'paid'` allocates the full line_total;
// `'booking'` allocates only the deposit — the shim intent that materializeSeededFolio converts
// into the allocations the line's derived money state is read from (line-autonomy).
const seedSoldSeats = async (opts: {
  organizationId: string
  agentId: string
  serviceId: string
  slotId: string
  startTime: string
  quantity: number
  state: 'paid' | 'booking'
  redeemedCount?: number
  lineTotal?: number
  deposit?: number
  date?: string
}): Promise<string> => {
  const folioId = crypto.randomUUID()
  const total = opts.lineTotal ?? 100000
  const paid = opts.state === 'paid' ? total : (opts.deposit ?? Math.floor(total * 0.3))
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at,
        payment_verification)
     VALUES (?, ?, ?, 'Ana Buceo', NULL, NULL, ?, ?, 0, ?, ?, ?, ?, 'verified')`,
  )
    .bind(folioId, opts.organizationId, opts.agentId, opts.state, total, total, paid, nowSec(), nowSec())
    .run()
  await env.DB.prepare(
    `INSERT INTO folio_lines
       (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date,
        slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
        qr_token, redeemed_count, created_at)
     VALUES (?, ?, ?, ?, ?, 'Tour Isla Mujeres', ?, ?, ?, 50000, 50000, 50000, ?, NULL, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      opts.organizationId,
      folioId,
      opts.serviceId,
      opts.slotId,
      opts.date ?? TODAY,
      opts.startTime,
      opts.quantity,
      total,
      opts.redeemedCount ?? 0,
      nowSec(),
    )
    .run()
  await materializeSeededFolio(folioId)
  return folioId
}

// A bare folio to hang hand-rolled ledger rows off (sales-summary tests never read the lines).
const seedBareFolio = async (
  organizationId: string,
  agentId: string,
  createdAt: number,
): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at,
        payment_verification)
     VALUES (?, ?, ?, 'Ana Buceo', NULL, NULL, 'paid', 100000, 0, 100000, 0, ?, ?, 'verified')`,
  )
    .bind(id, organizationId, agentId, createdAt, createdAt)
    .run()
  return id
}

const seedPaymentRow = (
  organizationId: string,
  folioId: string,
  entryType: 'payment' | 'refund' | 'commission' | 'commission_reversal',
  amount: number,
  collectedBy: string,
  at: number,
) =>
  env.DB.prepare(
    `INSERT INTO folio_payments
       (id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'cash', 'not_required', ?, ?)`,
  )
    .bind(crypto.randomUUID(), organizationId, folioId, entryType, amount, collectedBy, at)
    .run()

const withTz = (organizationId: string, tz: string) =>
  env.DB.prepare('UPDATE organizations SET timezone = ? WHERE id = ?').bind(tz, organizationId).run()

const getDay = async (email = ADMIN, qs = '') => {
  const res = await SELF.fetch(`${DAY_URL}${qs}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

// Full wipe: this suite seeds services, slots, folio_lines and folio_payments, which
// clearTenancyDb does not reach.
beforeEach(clearAffiliateDb)

describe('US-A14/US-A15 — occupancy rows', () => {
  it('S-1/S-4 — chronological rows with remaining and the vendidos/apartados split', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const serviceId = await seedService(organizationId)
    const busy = await seedSlot(organizationId, serviceId, '15:00', { capacity: 20, booked: 17 })
    await seedSlot(organizationId, serviceId, '18:00', { capacity: 20, booked: 5 })
    await seedSoldSeats({
      organizationId, agentId: userId, serviceId, slotId: busy,
      startTime: '15:00', quantity: 14, state: 'paid',
    })
    await seedSoldSeats({
      organizationId, agentId: userId, serviceId, slotId: busy,
      startTime: '15:00', quantity: 3, state: 'booking',
    })

    const { status, json } = await getDay()
    expect(status).toBe(200)
    expect(json.date).toBe(TODAY)
    expect(json.occupancy).toHaveLength(2)
    const [first, second] = json.occupancy
    expect(first.start_time).toBe('15:00')
    expect(first).toMatchObject({
      slot_id: busy, capacity: 20, booked: 17, remaining: 3,
      vendidos: 14, apartados: 3, is_flexible: false, flex_extra: 0,
    })
    expect(second.start_time).toBe('18:00')
    expect(second.remaining).toBe(15)
  })

  it('S-2 — a flexible slot full on base capacity reports its sellable margin', async () => {
    const { organizationId } = await seedUser({ email: ADMIN, role: 'admin' })
    const serviceId = await seedService(organizationId, { isFlexible: true, flexPct: 10 })
    await seedSlot(organizationId, serviceId, '16:00', { capacity: 20, booked: 20 })

    const { json } = await getDay()
    expect(json.occupancy[0]).toMatchObject({
      booked: 20, remaining: 0, is_flexible: true, flex_extra: 2,
    })
  })

  it('an inactive slot does not appear', async () => {
    const { organizationId } = await seedUser({ email: ADMIN, role: 'admin' })
    const serviceId = await seedService(organizationId)
    await seedSlot(organizationId, serviceId, '16:00', { status: 'inactive' })

    const { json } = await getDay()
    expect(json.occupancy).toHaveLength(0)
  })
})

describe('US-A90 — «Ya partieron»', () => {
  it('S-9 — a departed slot reports boarding, not availability', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const serviceId = await seedService(organizationId)
    const dawn = await seedSlot(organizationId, serviceId, '07:00', { capacity: 20, booked: 3 })
    await seedSoldSeats({
      organizationId, agentId: userId, serviceId, slotId: dawn,
      startTime: '07:00', quantity: 3, state: 'paid', redeemedCount: 2,
    })

    const { json } = await getDay()
    expect(json.occupancy).toHaveLength(0)
    expect(json.departed).toHaveLength(1)
    expect(json.departed[0]).toMatchObject({
      slot_id: dawn, start_time: '07:00', vendidos: 3, abordaron: 2, sin_usar: 1,
    })
  })

  it('S-11 — a future day has no departed section, even for morning times', async () => {
    const { organizationId } = await seedUser({ email: ADMIN, role: 'admin' })
    const serviceId = await seedService(organizationId)
    await seedSlot(organizationId, serviceId, '07:00', { date: TOMORROW })

    const { json } = await getDay(ADMIN, `?date=${TOMORROW}`)
    expect(json.date).toBe(TOMORROW)
    expect(json.departed).toHaveLength(0)
    expect(json.occupancy).toHaveLength(1)
    expect(json.occupancy[0].start_time).toBe('07:00')
  })

  it('the departed boundary resolves in the ORG zone, not UTC', async () => {
    // Cancún is UTC−5: at the frozen 12:00Z it is 07:00 local. A 06:00 slot has departed;
    // an 08:00 slot has not — although BOTH are in the past as naive UTC times.
    const { organizationId } = await seedUser({ email: ADMIN, role: 'admin' })
    await withTz(organizationId, 'America/Cancun')
    const serviceId = await seedService(organizationId)
    const gone = await seedSlot(organizationId, serviceId, '06:00')
    const ahead = await seedSlot(organizationId, serviceId, '08:00')

    const { json } = await getDay()
    expect(json.departed.map((d: any) => d.slot_id)).toEqual([gone])
    expect(json.occupancy.map((o: any) => o.slot_id)).toEqual([ahead])
  })
})

describe('US-A16 — the day\'s money, by the ledger\'s dates', () => {
  it('S-6 — a settle today of last week\'s apartado is today\'s money, and not today\'s folio', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const sixDaysAgo = nowSec() - 6 * DAY
    const folioId = await seedBareFolio(organizationId, userId, sixDaysAgo)
    // The deposit was that week's money; only the settle is stamped today.
    await seedFolioLedgerRows({
      folioId, organizationId, agentId: userId,
      status: 'booking', amountPaid: 30000, createdAt: sixDaysAgo,
    })
    await seedPaymentRow(organizationId, folioId, 'payment', 70000, userId, nowSec())

    const { json } = await getDay()
    expect(json.sales.collected_cents).toBe(70000)
    expect(json.sales.folios_created).toBe(0)
  })

  it('S-7 — a refund handed back today subtracts, and commission accruals never count', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const lastMonth = nowSec() - 30 * DAY
    const folioId = await seedBareFolio(organizationId, userId, lastMonth)
    await seedPaymentRow(organizationId, folioId, 'payment', 50000, userId, nowSec())
    await seedPaymentRow(organizationId, folioId, 'refund', -20000, userId, nowSec())
    await seedPaymentRow(organizationId, folioId, 'commission', 5000, userId, nowSec())

    const { json } = await getDay()
    expect(json.sales.collected_cents).toBe(30000)
  })

  it('S-8 — attribution follows who took the money, sorted by amount, zero-net sellers omitted', async () => {
    const { organizationId, userId: adminId } = await seedUser({ email: ADMIN, role: 'admin' })
    const { userId: lauraId } = await seedUser({
      email: 'laura@empresa.com', name: 'Laura', role: 'agent', organizationId,
    })
    const { userId: idleId } = await seedUser({
      email: 'idle@empresa.com', name: 'Idle', role: 'agent', organizationId,
    })
    const folioId = await seedBareFolio(organizationId, adminId, nowSec())
    await seedPaymentRow(organizationId, folioId, 'payment', 30000, adminId, nowSec())
    await seedPaymentRow(organizationId, folioId, 'payment', 70000, lauraId, nowSec())
    await seedPaymentRow(organizationId, folioId, 'payment', 10000, idleId, nowSec())
    await seedPaymentRow(organizationId, folioId, 'refund', -10000, idleId, nowSec())

    const { json } = await getDay()
    expect(json.sales.folios_created).toBe(1)
    expect(json.sales.per_seller).toHaveLength(2)
    expect(json.sales.per_seller[0]).toMatchObject({ name: 'Laura', collected_cents: 70000 })
    expect(json.sales.per_seller[1].collected_cents).toBe(30000)
  })

  it('the day window resolves in the ORG zone: late-evening money stays on its own day', async () => {
    // Cancún (UTC−5): 03:00Z today is 22:00 local YESTERDAY — outside today's window.
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    await withTz(organizationId, 'America/Cancun')
    const folioId = await seedBareFolio(organizationId, userId, nowSec() - 30 * DAY)
    const threeAmUtc = Math.floor(Date.parse(`${TODAY}T03:00:00Z`) / 1000)
    const onePmUtc = Math.floor(Date.parse(`${TODAY}T13:00:00Z`) / 1000)
    await seedPaymentRow(organizationId, folioId, 'payment', 11111, userId, threeAmUtc)
    await seedPaymentRow(organizationId, folioId, 'payment', 40000, userId, onePmUtc)

    const { json } = await getDay()
    expect(json.sales.collected_cents).toBe(40000)
  })
})

describe('authorization and validation', () => {
  it('an agent may not read the dashboard → 403', async () => {
    const { organizationId } = await seedUser({ email: ADMIN, role: 'admin' })
    await seedUser({ email: 'agente@empresa.com', role: 'agent', organizationId })

    const { status } = await getDay('agente@empresa.com')
    expect(status).toBe(403)
  })

  it('a malformed date → 400 VALIDATION_ERROR', async () => {
    await seedUser({ email: ADMIN, role: 'admin' })

    const { status, json } = await getDay(ADMIN, '?date=hoy')
    expect(status).toBe(400)
    expect(json.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('multitenancy isolation (S-12)', () => {
  it('another org\'s slots and money appear nowhere', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const svcA = await seedService(orgA.organizationId)
    const svcB = await seedService(orgB.organizationId)
    const slotA = await seedSlot(orgA.organizationId, svcA, '15:00', { booked: 4 })
    await seedSlot(orgB.organizationId, svcB, '15:00', { booked: 9 })
    const folioA = await seedBareFolio(orgA.organizationId, orgA.adminUserId, nowSec())
    const folioB = await seedBareFolio(orgB.organizationId, orgB.adminUserId, nowSec())
    await seedPaymentRow(orgA.organizationId, folioA, 'payment', 40000, orgA.adminUserId, nowSec())
    await seedPaymentRow(orgB.organizationId, folioB, 'payment', 99900, orgB.adminUserId, nowSec())

    const { json } = await getDay(orgA.adminEmail)
    expect(json.occupancy.map((o: any) => o.slot_id)).toEqual([slotA])
    expect(json.occupancy[0].booked).toBe(4)
    expect(json.sales.collected_cents).toBe(40000)
    expect(json.sales.folios_created).toBe(1)
    expect(json.sales.per_seller).toHaveLength(1)
  })
})
