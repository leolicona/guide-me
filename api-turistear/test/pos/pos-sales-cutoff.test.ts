import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A47 — sales cutoff: a slot stops being sellable once its departure passes the org's signed
// cutoff offset (+ before / − after, a grace window). Closes the past-slot hole on the WRITE side
// (confirmSale: full sale + booking creation) and hides past times on the READ side (the matrix).
// The suite clock is frozen to 2026-06-14T12:00:00Z (test/helpers/apply-migrations.ts).
const AGENT_EMAIL = 'agent@empresa.com'
const TODAY = '2026-06-14' // = frozen utcToday()

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/pos'

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'active', ?, ?)`,
  )
    .bind(id, organizationId, ts, ts)
    .run()
  return id
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  startTime: string,
  date = TODAY,
): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 12, 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, date, startTime, ts, ts)
    .run()
  return id
}

const setSalesCutoff = (orgId: string, minutes: number) =>
  env.DB.prepare(`UPDATE organizations SET sales_cutoff_offset_minutes = ? WHERE id = ?`)
    .bind(minutes, orgId)
    .run()

const bookedOf = async (slotId: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(slotId).first<{ booked: number }>())!.booked

const sell = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ customer_name: 'Cliente Test', customer_phone: '5512345678', customer_email: 'cliente@example.com', ...body }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const getServiceDetail = async (email: string, serviceId: string) => {
  const res = await SELF.fetch(`${base}/services/${serviceId}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

const listServices = async (email: string) => {
  const res = await SELF.fetch(`${base}/services?today=${TODAY}&date=${TODAY}`, { headers: auth(email) })
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

describe('US-A47 — sales cutoff', () => {
  it('a full sale on a slot that already departed → 409 SLOT_CLOSED; spots untouched', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId) // cutoff defaults to 0
    const slotId = await seedSlot(organizationId, serviceId, '08:00') // 4h before frozen now

    const { status, json } = await sell(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })

    expect(status).toBe(409)
    expect(json.error?.code ?? json.code).toBe('SLOT_CLOSED')
    expect(await bookedOf(slotId)).toBe(0)
  })

  it('a booking (deposit) on a departed slot is refused the same way', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, '11:30') // 30 min ago — the reported case

    const { status, json } = await sell(AGENT_EMAIL, {
      customer_phone: '+52 55 1234 5678',
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })

    expect(status).toBe(409)
    expect(json.error?.code ?? json.code).toBe('SLOT_CLOSED')
    expect(await bookedOf(slotId)).toBe(0)
  })

  it('a positive cutoff closes sales BEFORE departure', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    await setSalesCutoff(organizationId, 10) // close 10 min before departure
    const slotId = await seedSlot(organizationId, serviceId, '12:05') // departs in 5 min < cutoff

    const { status, json } = await sell(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(409)
    expect(json.error?.code ?? json.code).toBe('SLOT_CLOSED')
  })

  it('a NEGATIVE cutoff (grace) keeps a just-departed slot sellable', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    await setSalesCutoff(organizationId, -10) // grace: sellable up to 10 min AFTER departure
    const slotId = await seedSlot(organizationId, serviceId, '11:55') // departed 5 min ago, within grace

    const { status } = await sell(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(await bookedOf(slotId)).toBe(1)
  })

  it('the service-detail matrix shows only still-sellable times (past same-day slot dropped)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId) // cutoff 0
    await seedSlot(organizationId, serviceId, '08:00') // past — must be hidden
    await seedSlot(organizationId, serviceId, '18:00') // future — must remain

    const { status, json } = await getServiceDetail(AGENT_EMAIL, serviceId)
    expect(status).toBe(200)
    const times = json.service.slots.map((s: any) => s.start_time)
    expect(times).toEqual(['18:00'])
  })

  it('catalog availability ignores a service whose only slot today has departed', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const past = await seedService(organizationId)
    await seedSlot(organizationId, past, '08:00') // only a departed slot
    const live = await seedService(organizationId)
    await seedSlot(organizationId, live, '18:00') // a future slot

    const { json } = await listServices(AGENT_EMAIL)
    const byId = new Map(json.services.map((s: any) => [s.id, s]))
    expect(byId.get(past)?.has_availability).toBe(false)
    expect(byId.get(live)?.has_availability).toBe(true)
  })
})
