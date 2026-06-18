import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Bookings / down-payments — creation (US-AG07, US-AG07.1).
// Spec: docs/bookings/bookings-down-payments.spec.md §7 (Sc.1–6, 8 creation half, 17).
// A `down_payment` on POST /api/pos/folios switches the existing confirm into BOOKING mode.

const AGENT_EMAIL = 'agent@empresa.com'
const PHONE = '+52 55 1234 5678'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const base = 'http://api.local/api/pos'

// Naive-calendar helpers (mirror the handler / dates.ts).
const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const epoch = (date: string, time: string): number =>
  Math.floor(Date.parse(`${date}T${time}:00Z`) / 1000)

const seedService = async (opts: {
  organizationId: string
  basePrice?: number
  minimumPrice?: number
  commissionType?: 'percent' | 'fixed'
  commissionValue?: number
}): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, ?, ?, 12, ?, ?, 'active', ?, ?)`,
  )
    .bind(
      serviceId,
      opts.organizationId,
      opts.basePrice ?? 150000,
      opts.minimumPrice ?? 100000,
      opts.commissionType ?? 'percent',
      opts.commissionValue ?? 0,
      ts,
      ts,
    )
    .run()
  return { serviceId }
}

const seedSlot = async (opts: {
  organizationId: string
  serviceId: string
  date?: string
  startTime?: string
  capacity?: number
  booked?: number
}): Promise<{ slotId: string }> => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(
      slotId,
      opts.organizationId,
      opts.serviceId,
      opts.date ?? addDays(todayStr(), 3),
      opts.startTime ?? '06:00',
      opts.capacity ?? 12,
      opts.booked ?? 0,
      ts,
      ts,
    )
    .run()
  return { slotId }
}

const setOrgPolicy = async (
  orgId: string,
  p: { minPct?: number; holdDays?: number; bufferMin?: number },
) => {
  await env.DB.prepare(
    `UPDATE organizations SET booking_min_down_payment_pct = ?, booking_hold_days = ?, booking_grace_offset_minutes = ? WHERE id = ?`,
  )
    .bind(p.minPct ?? 0, p.holdDays ?? 7, p.bufferMin ?? 15, orgId)
    .run()
}

const getSlotBooked = async (id: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(id).first<{ booked: number }>())!.booked

const getFolio = (id: string) =>
  env.DB.prepare(
    `SELECT status, amount_paid, total, commission_amount, booking_expires_at FROM folios WHERE id = ?`,
  )
    .bind(id)
    .first<{ status: string; amount_paid: number; total: number; commission_amount: number; booking_expires_at: number | null }>()

const post = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ customer_email: 'cliente@example.com', ...body }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-AG07 — booking creation', () => {
  it('Sc.1 — happy booking: status booking, deposit held, spots reserved, no QR', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await setOrgPolicy(organizationId, { minPct: 0, holdDays: 7 })
    const { serviceId } = await seedService({ organizationId, basePrice: 150000 })
    const slotDate = addDays(todayStr(), 3)
    const { slotId } = await seedSlot({ organizationId, serviceId, date: slotDate, startTime: '06:00' })

    const { status, json } = await post(AGENT_EMAIL, {
      customer_phone: PHONE,
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })

    expect(status).toBe(201)
    expect(json.folio).toMatchObject({
      status: 'booking',
      total: 300000,
      amount_paid: 45000,
      pending_balance: 255000,
    })
    // Non-same-day: expiry = slotStart − 24h (within the 7-day hold window).
    expect(json.folio.booking_expires_at).toBe(epoch(slotDate, '06:00') - 86_400)
    expect(json.folio.lines[0].qr_token).toBeNull()
    expect(json.folio.lines[0].qr).toBeNull()
    expect(await getSlotBooked(slotId)).toBe(2) // spots reserved

    const row = await getFolio(json.folio.id)
    expect(row).toMatchObject({ status: 'booking', amount_paid: 45000 })
  })

  it('Sc.2 — phone required for a booking; full sale without phone still works', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    const { slotId } = await seedSlot({ organizationId, serviceId })

    const noPhone = await post(AGENT_EMAIL, {
      down_payment: 50000,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(noPhone.status).toBe(400)
    expect(noPhone.json.error.code).toBe('VALIDATION_ERROR')

    const fullNoPhone = await post(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(fullNoPhone.status).toBe(201)
    expect(fullNoPhone.json.folio.status).toBe('paid')
  })

  it('Sc.3 — below the org minimum % → 400; exactly the minimum → 201', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await setOrgPolicy(organizationId, { minPct: 30 })
    const { serviceId } = await seedService({ organizationId, basePrice: 150000 })
    const { slotId } = await seedSlot({ organizationId, serviceId })

    const below = await post(AGENT_EMAIL, {
      customer_phone: PHONE,
      down_payment: 30000, // 20% of 150000 < 30%
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(below.status).toBe(400)
    expect(below.json.error.code).toBe('DOWN_PAYMENT_BELOW_MINIMUM')
    expect(await getSlotBooked(slotId)).toBe(0) // no decrement on rejection

    const ok = await post(AGENT_EMAIL, {
      customer_phone: PHONE,
      down_payment: 45000, // exactly 30%
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(ok.status).toBe(201)
  })

  it('Sc.4 — deposit ≥ total → 400 (a full payment is not a booking)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, basePrice: 150000 })
    const { slotId } = await seedSlot({ organizationId, serviceId })

    const { status, json } = await post(AGENT_EMAIL, {
      customer_phone: PHONE,
      down_payment: 150000,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(400)
    expect(json.error.code).toBe('VALIDATION_ERROR')
  })

  it('Sc.6 — same-day tour uses the same-day buffer for expiry', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await setOrgPolicy(organizationId, { bufferMin: 15, holdDays: 7 })
    const { serviceId } = await seedService({ organizationId, basePrice: 150000 })
    const today = todayStr()
    const { slotId } = await seedSlot({ organizationId, serviceId, date: today, startTime: '23:59' })

    const { status, json } = await post(AGENT_EMAIL, {
      customer_phone: PHONE,
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(json.folio.booking_expires_at).toBe(epoch(today, '23:59') - 15 * 60)
  })

  it('Sc.8 — commission accrues percent-on-collected; fixed accrues nothing at booking', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    // percent 10% (1000 bp): fullPercent on 150000 = 15000; deposit 45000/150000 → 4500.
    const pct = await seedService({ organizationId, basePrice: 150000, commissionType: 'percent', commissionValue: 1000 })
    const slotP = await seedSlot({ organizationId, serviceId: pct.serviceId })
    const bookingP = await post(AGENT_EMAIL, {
      customer_phone: PHONE,
      down_payment: 45000,
      lines: [{ slot_id: slotP.slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(bookingP.json.folio.commission_amount).toBe(4500)

    // fixed $500/spot (50000): accrues 0 at booking.
    const fix = await seedService({ organizationId, basePrice: 150000, commissionType: 'fixed', commissionValue: 50000 })
    const slotF = await seedSlot({ organizationId, serviceId: fix.serviceId })
    const bookingF = await post(AGENT_EMAIL, {
      customer_phone: PHONE,
      down_payment: 45000,
      lines: [{ slot_id: slotF.slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(bookingF.json.folio.commission_amount).toBe(0)
  })

  it('Sc.17 — backward compat: no down_payment is a normal paid sale with QR', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, basePrice: 150000 })
    const { slotId } = await seedSlot({ organizationId, serviceId })

    const { status, json } = await post(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(json.folio).toMatchObject({ status: 'paid', amount_paid: 150000, pending_balance: 0, booking_expires_at: null })
    expect(json.folio.lines[0].qr_token).not.toBeNull()
  })
})
