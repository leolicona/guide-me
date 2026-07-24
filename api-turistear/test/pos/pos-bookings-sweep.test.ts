import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import { sweepExpiredBookings } from '../../src/routes/pos/sweep'

// Bookings / down-payments — auto-expiry sweep (US-AG07 P3).
// Spec: docs/bookings/bookings-down-payments.spec.md §7 (Sc.11 + isolation).
// The sweep is driven directly (not via cron) and writes per-folio org-filtered.

const PHONE = '+52 55 1234 5678'
const jsonAuth = (email: string) => ({
  Cookie: `gm_access=${buildFakeJwt(email)}`,
  'Content-Type': 'application/json',
})
const base = 'http://api.local/api/pos'
const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', 0, 'active', ?, ?)`,
  ).bind(id, organizationId, ts, ts).run()
  return id
}
const seedSlot = async (organizationId: string, serviceId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  ).bind(id, organizationId, serviceId, addDays(todayStr(), 3), ts, ts).run()
  return id
}
const createBooking = async (email: string, slotId: string): Promise<string> => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_email: 'c@example.com',
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}
const expire = (folioId: string) =>
  env.DB.prepare(`UPDATE folios SET booking_expires_at = ? WHERE id = ?`)
    .bind(Math.floor(Date.now() / 1000) - 60, folioId)
    .run()
const getFolio = (id: string) =>
  env.DB.prepare(`SELECT status, amount_paid, cancellation_reason FROM folios WHERE id = ?`).bind(id).first<any>()
const getSlotBooked = async (id: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(id).first<{ booked: number }>())!.booked

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

describe('US-AG07 P3 — auto-expiry sweep', () => {
  it('Sc.11 — expired booking is cancelled, spots freed, deposit retained', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    expect(await getSlotBooked(slotId)).toBe(2)
    await expire(folioId)

    const swept = await sweepExpiredBookings(env)
    expect(swept).toBe(1)

    const row = await getFolio(folioId)
    expect(row.status).toBe('cancelled')
    expect(row.cancellation_reason).toBe('Apartado vencido')
    expect(row.amount_paid).toBe(45000) // deposit retained
    expect(await getSlotBooked(slotId)).toBe(0) // spots freed
  })

  it('isolation — only past-expiry bookings are swept, each under its own org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: agentB, role: 'agent', organizationId: orgB.organizationId })

    const svcA = await seedService(orgA.organizationId)
    const slotA = await seedSlot(orgA.organizationId, svcA)
    const folioA = await createBooking(agentA, slotA)
    await expire(folioA) // A is past expiry

    const svcB = await seedService(orgB.organizationId)
    const slotB = await seedSlot(orgB.organizationId, svcB)
    const folioB = await createBooking(agentB, slotB) // B keeps its future expiry

    const swept = await sweepExpiredBookings(env)
    expect(swept).toBe(1)

    expect((await getFolio(folioA)).status).toBe('cancelled')
    expect(await getSlotBooked(slotA)).toBe(0)
    expect((await getFolio(folioB)).status).toBe('booking') // untouched
    expect(await getSlotBooked(slotB)).toBe(2)
  })
})
