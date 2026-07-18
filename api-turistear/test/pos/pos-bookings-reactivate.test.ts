import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Bookings / down-payments — late-arrival reactivation (US-AG07.5, reactivation only).
// Spec: docs/bookings/bookings-down-payments.spec.md §7 (Sc.12 capacity, Sc.13 full, isolation).

const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
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
      customer_phone: PHONE,
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}
const cancel = (email: string, id: string) =>
  SELF.fetch(`${base}/folios/${id}/cancel`, { method: 'POST', headers: jsonAuth(email), body: '{}' })
const reactivate = async (email: string, id: string) => {
  const res = await SELF.fetch(`${base}/folios/${id}/reactivate`, { method: 'POST', headers: jsonAuth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const setBooked = (slotId: string, booked: number) =>
  env.DB.prepare(`UPDATE slots SET booked = ? WHERE id = ?`).bind(booked, slotId).run()
const getSlotBooked = async (id: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(id).first<{ booked: number }>())!.booked
const getFolioStatus = async (id: string) =>
  (await env.DB.prepare(`SELECT status FROM folios WHERE id = ?`).bind(id).first<{ status: string }>())!.status

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

describe('US-AG07.5 — reactivate', () => {
  it('Sc.12 — capacity available: re-blocks spots, back to booking', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    await cancel('agent@empresa.com', folioId)
    expect(await getSlotBooked(slotId)).toBe(0)

    const { status, json } = await reactivate('agent@empresa.com', folioId)
    expect(status).toBe(200)
    expect(json.folio.status).toBe('booking')
    expect(await getSlotBooked(slotId)).toBe(2) // re-blocked
  })

  it('Sc.13 — tour now full: 409 NO_CAPACITY_AVAILABLE, slot untouched', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    await cancel('agent@empresa.com', folioId)
    await setBooked(slotId, 11) // capacity 12, only 1 left; the booking needs 2

    const { status, json } = await reactivate('agent@empresa.com', folioId)
    expect(status).toBe(409)
    expect(json.error.code).toBe('NO_CAPACITY_AVAILABLE')
    expect(await getSlotBooked(slotId)).toBe(11) // compensated — unchanged
    expect(await getFolioStatus(folioId)).toBe('cancelled')
  })

  it('isolation — foreign agent cannot reactivate', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: agentB, role: 'agent', organizationId: orgB.organizationId })
    const serviceId = await seedService(orgA.organizationId)
    const slotId = await seedSlot(orgA.organizationId, serviceId)
    const folioId = await createBooking(agentA, slotId)
    await cancel(agentA, folioId)

    expect((await reactivate(agentB, folioId)).status).toBe(404)
  })
})
