import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import { sweepExpiredBookings } from '../../src/routes/pos/sweep'

// Zoned Capacity (US-A64) — release paths (Phase 3). Every path that returns seats must hand them
// back to the ZONE counter and reconcile the slot: manual cancel (Sc.7), expiry sweep (Sc.15),
// un-cancel re-block (Sc.16), and the re-block that fails because the zone refilled (Sc.17).

const AGENT = 'agent@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/pos'
const ts = () => Math.floor(Date.now() / 1000)
const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const SLOT_DATE = addDays(todayStr(), 3)

// --- Seeders (raw D1) ------------------------------------------------------

const seedZonedService = async (organizationId: string) => {
  const serviceId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        commission_type, commission_value, zones_enabled, category, status, created_at, updated_at)
     VALUES (?, ?, 'Turibus', NULL, 150000, 100000, 50, 'percent', 0, 1, 'tours', 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, ts(), ts())
    .run()
  const slotId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 50, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, SLOT_DATE, ts(), ts())
    .run()
  const mkZone = async (name: string, cap: number, sort: number) => {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO service_zones (id, organization_id, service_id, name, capacity, sort_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
      .bind(id, organizationId, serviceId, name, cap, sort, ts(), ts())
      .run()
    await env.DB.prepare(
      `INSERT INTO slot_zones (id, organization_id, slot_id, zone_id, capacity, booked, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
    )
      .bind(crypto.randomUUID(), organizationId, slotId, id, cap, ts(), ts())
      .run()
    return id
  }
  const alto = await mkZone('Piso alto', 20, 0)
  const bajo = await mkZone('Piso bajo', 30, 1)
  return { serviceId, slotId, alto, bajo }
}

// --- Readers ---------------------------------------------------------------

const zoneBooked = async (slotId: string, zoneId: string): Promise<number> =>
  ((await env.DB.prepare('SELECT booked FROM slot_zones WHERE slot_id = ? AND zone_id = ?')
    .bind(slotId, zoneId)
    .first()) as { booked: number }).booked

const slotBooked = async (slotId: string): Promise<number> =>
  ((await env.DB.prepare('SELECT booked FROM slots WHERE id = ?').bind(slotId).first()) as {
    booked: number
  }).booked

const folioStatus = async (id: string): Promise<string> =>
  ((await env.DB.prepare('SELECT status FROM folios WHERE id = ?').bind(id).first()) as {
    status: string
  }).status

// --- Actions ---------------------------------------------------------------

// A full PAID sale of `qty` seats in a zone.
const sellPaid = async (slotId: string, zoneId: string, qty: number): Promise<string> => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(AGENT),
    body: JSON.stringify({
      customer_name: 'Cliente Test',
      customer_phone: '5512345678',
      customer_email: 'c@example.com',
      lines: [{ slot_id: slotId, zone_id: zoneId, quantity: qty, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as { folio: { id: string } }
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}

// A BOOKING (apartado) of `qty` seats in a zone.
const bookZone = async (slotId: string, zoneId: string, qty: number): Promise<string> => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(AGENT),
    body: JSON.stringify({
      customer_email: 'c@example.com',
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      down_payment: 30000,
      lines: [{ slot_id: slotId, zone_id: zoneId, quantity: qty, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as { folio: { id: string } }
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}

const cancel = (id: string) =>
  SELF.fetch(`${base}/folios/${id}/cancel`, { method: 'POST', headers: jsonAuth(AGENT), body: '{}' })
const reactivate = (id: string) =>
  SELF.fetch(`${base}/folios/${id}/reactivate`, { method: 'POST', headers: auth(AGENT) })
const expire = (id: string) =>
  env.DB.prepare('UPDATE folios SET booking_expires_at = ? WHERE id = ?')
    .bind(ts() - 60, id)
    .run()

// US-A77 — the sweep only CANCELS once the grace instant passes; the settle deadline alone just
// notifies. It reads each line's snapshotted departure, so that is what moves. Test orgs are UTC.
const arriveAtGrace = async (folioId: string) => {
  const now = new Date()
  await env.DB.prepare(
    'UPDATE folio_lines SET slot_date = ?, slot_start_time = ? WHERE folio_id = ?',
  )
    .bind(now.toISOString().slice(0, 10), now.toISOString().slice(11, 16), folioId)
    .run()
  await expire(folioId)
}

const clearDb = async () => {
  for (const t of [
    'folio_line_extras',
    'folio_access_tokens',
    'slot_zones',
    'folio_events',
    'folio_requests',
    'folio_lines',
    'folio_payments',
    'notifications',
    'folios',
    'service_zones',
    'slots',
    'schedules',
    'services',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
  // RETIRED with US-AG07.5 (docs/bookings/booking-reschedule.spec.md, D3). These scenarios drove the
  // `/reactivate` endpoint, which cleared `cancelled_at` and left the history asserting an expiry
  // never happened — after the customer had been told it did. They are DELETED rather than rewritten
  // against another endpoint: a deletion is the honest form of retiring a capability, and editing
  // them into something else would hide that one was removed.
  //
  // What they covered that still matters — that a re-block obeys the same atomic capacity guard as
  // a sale — is now covered by the reschedule's destination guard (S-3).

describe('US-A64 §4 — release paths', () => {
  it('Scenario 7 — cancelling releases the zone counter and reconciles the slot', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    const { slotId, alto } = await seedZonedService(organizationId)
    const folioId = await bookZone(slotId, alto, 3)
    expect(await zoneBooked(slotId, alto)).toBe(3)
    expect(await slotBooked(slotId)).toBe(3)

    const res = await cancel(folioId)
    expect(res.status).toBe(200)
    expect(await folioStatus(folioId)).toBe('cancelled')
    expect(await zoneBooked(slotId, alto)).toBe(0) // zone freed
    expect(await slotBooked(slotId)).toBe(0) // reconciled
  })

  it('Scenario 15 — the expiry sweep releases zone seats', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    const { slotId, alto } = await seedZonedService(organizationId)
    const folioId = await bookZone(slotId, alto, 3)
    await arriveAtGrace(folioId)

    const result = await sweepExpiredBookings(env)
    expect(result).toMatchObject({ cancelled: 1, failed: 0 })
    expect(await folioStatus(folioId)).toBe('cancelled')
    expect(await zoneBooked(slotId, alto)).toBe(0)
    expect(await slotBooked(slotId)).toBe(0)
  })


})
