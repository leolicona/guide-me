import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Bookings / down-payments — one-shot settlement (US-AG07).
// Spec: docs/bookings/bookings-down-payments.spec.md §7 (Sc.7, 8 settle half, 9 guards, 16 isolation).

const AGENT_EMAIL = 'agent@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/pos'

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (opts: {
  organizationId: string
  commissionType?: 'percent' | 'fixed'
  commissionValue?: number
}): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, ?, ?, 'active', ?, ?)`,
  )
    .bind(serviceId, opts.organizationId, opts.commissionType ?? 'percent', opts.commissionValue ?? 0, ts, ts)
    .run()
  return { serviceId }
}

const seedSlot = async (opts: {
  organizationId: string
  serviceId: string
  date?: string
  booked?: number
}): Promise<{ slotId: string }> => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, ?, 'active', ?, ?)`,
  )
    .bind(slotId, opts.organizationId, opts.serviceId, opts.date ?? addDays(todayStr(), 3), opts.booked ?? 0, ts, ts)
    .run()
  return { slotId }
}

const createBooking = async (
  email: string,
  slotId: string,
  opts: { quantity?: number; deposit?: number } = {},
): Promise<string> => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_email: 'cliente@example.com',
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      down_payment: opts.deposit ?? 45000,
      lines: [{ slot_id: slotId, quantity: opts.quantity ?? 2, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}

const settle = async (email: string, folioId: string) => {
  const res = await SELF.fetch(`${base}/folios/${folioId}/settle`, { method: 'POST', headers: jsonAuth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

const getSlotBooked = async (id: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(id).first<{ booked: number }>())!.booked
const getFolio = (id: string) =>
  env.DB.prepare(`SELECT status, amount_paid, commission_amount, settled_by FROM folios WHERE id = ?`)
    .bind(id)
    .first<{ status: string; amount_paid: number; commission_amount: number; settled_by: string | null }>()

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

describe('US-AG07 — settle a booking', () => {
  it('Sc.7 — settle flips to paid, mints QR, sets settled_by; inventory untouched', async () => {
    const { userId, organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    const { slotId } = await seedSlot({ organizationId, serviceId })
    const folioId = await createBooking(AGENT_EMAIL, slotId, { quantity: 2, deposit: 45000 })
    expect(await getSlotBooked(slotId)).toBe(2)

    const { status, json } = await settle(AGENT_EMAIL, folioId)
    expect(status).toBe(200)
    expect(json.folio).toMatchObject({ status: 'paid', amount_paid: 300000 })
    expect(json.folio.lines[0].qr_token).not.toBeNull()
    expect(await getSlotBooked(slotId)).toBe(2) // not re-decremented

    const row = await getFolio(folioId)
    expect(row).toMatchObject({ status: 'paid', amount_paid: 300000, settled_by: userId })
  })

  it('Sc.8 — commission tops up at settle (percent on full; fixed now accrues)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    // percent 10% on total 150000 → 15000 at settle (was 4500 at booking).
    const pct = await seedService({ organizationId, commissionType: 'percent', commissionValue: 1000 })
    const slotP = await seedSlot({ organizationId, serviceId: pct.serviceId })
    const folioP = await createBooking(AGENT_EMAIL, slotP.slotId, { quantity: 1, deposit: 45000 })
    expect((await getFolio(folioP))!.commission_amount).toBe(4500)
    await settle(AGENT_EMAIL, folioP)
    expect((await getFolio(folioP))!.commission_amount).toBe(15000)

    // fixed 50000/spot → 0 at booking, 50000 at settle.
    const fix = await seedService({ organizationId, commissionType: 'fixed', commissionValue: 50000 })
    const slotF = await seedSlot({ organizationId, serviceId: fix.serviceId })
    const folioF = await createBooking(AGENT_EMAIL, slotF.slotId, { quantity: 1, deposit: 45000 })
    expect((await getFolio(folioF))!.commission_amount).toBe(0)
    await settle(AGENT_EMAIL, folioF)
    expect((await getFolio(folioF))!.commission_amount).toBe(50000)
  })

  it('Sc.9 — guards: already-settled / cancelled / expired / unknown', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    const { slotId } = await seedSlot({ organizationId, serviceId })

    // already settled
    const f1 = await createBooking(AGENT_EMAIL, slotId)
    expect((await settle(AGENT_EMAIL, f1)).status).toBe(200)
    const again = await settle(AGENT_EMAIL, f1)
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('ALREADY_SETTLED')

    // cancelled
    const f2 = await createBooking(AGENT_EMAIL, slotId)
    await env.DB.prepare(`UPDATE folios SET status = 'cancelled' WHERE id = ?`).bind(f2).run()
    const cancelled = await settle(AGENT_EMAIL, f2)
    expect(cancelled.status).toBe(409)
    expect(cancelled.json.error.code).toBe('FOLIO_CANCELLED')

    // expired
    const f3 = await createBooking(AGENT_EMAIL, slotId)
    await env.DB.prepare(`UPDATE folios SET booking_expires_at = ? WHERE id = ?`)
      .bind(Math.floor(Date.now() / 1000) - 60, f3)
      .run()
    const expired = await settle(AGENT_EMAIL, f3)
    expect(expired.status).toBe(409)
    expect(expired.json.error.code).toBe('BOOKING_EXPIRED')

    // unknown
    expect((await settle(AGENT_EMAIL, crypto.randomUUID())).status).toBe(404)
  })

  it('Sc.16 — B4 isolation: an agent cannot settle another org’s booking', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: agentB, role: 'agent', organizationId: orgB.organizationId })
    const { serviceId } = await seedService({ organizationId: orgA.organizationId })
    const { slotId } = await seedSlot({ organizationId: orgA.organizationId, serviceId })
    const folioId = await createBooking(agentA, slotId)

    const foreign = await settle(agentB, folioId)
    expect(foreign.status).toBe(404)
    // untouched — still a booking for org A
    expect((await getFolio(folioId))!.status).toBe('booking')
  })
})
