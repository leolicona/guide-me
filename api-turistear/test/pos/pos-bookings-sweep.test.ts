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
// `hour` gives each slot its own departure time: (organization, service, date, start_time) is
// UNIQUE, so a test seeding two slots for the same service on the same day must vary it.
const seedSlot = async (
  organizationId: string,
  serviceId: string,
  hour = '06:00',
): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 12, 0, 'active', ?, ?)`,
  ).bind(id, organizationId, serviceId, addDays(todayStr(), 3), hour, ts, ts).run()
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
// Push the folio past its STAGE-① boundary: the settle deadline has passed, so the sweep should
// notify and let it into the grace window — not cancel it.
const expire = (folioId: string) =>
  env.DB.prepare(`UPDATE folios SET booking_expires_at = ? WHERE id = ?`)
    .bind(Math.floor(Date.now() / 1000) - 60, folioId)
    .run()

// Push the folio past its GRACE instant, which is what actually cancels. The sweep reads each
// LINE's snapshotted departure (a folio prices by the departure it was sold for, even if the slot
// is later moved), so the line is what has to move. Test orgs are seeded in UTC, so a UTC
// wall-clock IS the org-local one.
const arriveAtGrace = async (folioId: string) => {
  const now = new Date()
  await env.DB.prepare(
    `UPDATE folio_lines SET slot_date = ?, slot_start_time = ? WHERE folio_id = ?`,
  )
    .bind(now.toISOString().slice(0, 10), now.toISOString().slice(11, 16), folioId)
    .run()
  await expire(folioId)
}
const getFolio = (id: string) =>
  env.DB.prepare(
    `SELECT status, amount_paid, cancellation_reason, refund_status, cancellation_source, reminder_status
       FROM folios WHERE id = ?`,
  )
    .bind(id)
    .first<any>()
const getSlotBooked = async (id: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(id).first<{ booked: number }>())!.booked

const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

// US-A77 — the sweep drives TWO stages now. Reaching the settle deadline no longer cancels
// anything: it notifies the customer and lets the hold run to the grace instant. This is the
// change, so both halves are asserted separately.
describe('US-A77 — the settle deadline notifies instead of cancelling', () => {
  it('Sc.11 (revised) — past the deadline the folio is NOTIFIED, and keeps its spots', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId) // departs in 3 days
    const folioId = await createBooking('agent@empresa.com', slotId)
    await expire(folioId)

    const result = await sweepExpiredBookings(env)
    expect(result).toMatchObject({ cancelled: 0, failed: 0 })

    const row = await getFolio(folioId)
    expect(row.status).toBe('booking') // still alive — this used to cancel here
    expect(await getSlotBooked(slotId)).toBe(2) // spots still held
  })

  it('the notification is claimed once — a second run does not re-send', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    await expire(folioId)
    // The agent already sent the WhatsApp reminder by hand. `reminder_status` is deliberately
    // shared between the two channels: whoever told the customer first, the customer was told.
    await env.DB.prepare(`UPDATE folios SET reminder_status = 'sent' WHERE id = ?`)
      .bind(folioId)
      .run()

    const result = await sweepExpiredBookings(env)
    expect(result).toMatchObject({ notified: 0, cancelled: 0, failed: 0 })
  })

  it('at the grace instant the folio IS cancelled, spots freed, priced by the ladder', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    expect(await getSlotBooked(slotId)).toBe(2)
    await arriveAtGrace(folioId)

    const result = await sweepExpiredBookings(env)
    expect(result).toMatchObject({ cancelled: 1, failed: 0 })

    const row = await getFolio(folioId)
    expect(row.status).toBe('cancelled')
    expect(row.cancellation_reason).toBe('Apartado vencido')
    expect(row.amount_paid).toBe(45000)
    expect(await getSlotBooked(slotId)).toBe(0) // spots freed
    // Priced by the engine, not by a hardcoded rule: at the grace instant the departure is minutes
    // away, so the ladder is in its terminal tier and nothing is owed back.
    expect(row.refund_status).toBe('none')
    expect(row.cancellation_source).toBe('system_expiry')
  })

  it('one broken folio does not abort the run', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: agentB, role: 'agent', organizationId: orgB.organizationId })

    const good = await createBooking(
      agentA,
      await seedSlot(orgA.organizationId, await seedService(orgA.organizationId)),
    )
    await arriveAtGrace(good)

    const bad = await createBooking(
      agentB,
      await seedSlot(orgB.organizationId, await seedService(orgB.organizationId)),
    )
    await arriveAtGrace(bad)
    // Corrupt data rather than a contrived stub: an unreadable timezone makes resolving this
    // folio's departure throw. Written straight to the column, bypassing the Zod allow-list that
    // would refuse it through the API — which is the only way a row like this exists.
    await env.DB.prepare(`UPDATE organizations SET timezone = 'Not/AZone' WHERE id = ?`)
      .bind(orgB.organizationId)
      .run()

    const result = await sweepExpiredBookings(env)
    expect(result).toMatchObject({ cancelled: 1, failed: 1 })
    // The healthy folio behind the broken one was still processed. Before the per-folio guard, a
    // single throw aborted the run and every apartado after it silently kept its seats.
    expect((await getFolio(good)).status).toBe('cancelled')
    expect((await getFolio(bad)).status).toBe('booking')
  })

  // US-A77 (S1) — an apartado may not be opened inside the creation cutoff. The same slot is still
  // sellable: what is refused is the DEPOSIT, not the service.
  it('refuses an apartado inside the creation cutoff, but still sells it in full', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId) // departs in 3 days (~72h)
    // Cutoff of 96h: this slot is inside it.
    await env.DB.prepare(
      `UPDATE organizations SET booking_creation_cutoff_hours = 96 WHERE id = ?`,
    )
      .bind(organizationId)
      .run()

    const rejected = await SELF.fetch(`${base}/folios`, {
      method: 'POST',
      headers: jsonAuth('agent@empresa.com'),
      body: JSON.stringify({
        customer_email: 'c@example.com',
        customer_name: 'Cliente Test',
        customer_phone: PHONE,
        down_payment: 45000,
        lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
      }),
    })
    expect(rejected.status).toBe(422)
    expect(((await rejected.json()) as any).error.code).toBe('BOOKING_TOO_LATE')

    // Same slot, full payment — unaffected. The sales cutoff governs that, and it is still 0.
    const paid = await SELF.fetch(`${base}/folios`, {
      method: 'POST',
      headers: jsonAuth('agent@empresa.com'),
      body: JSON.stringify({
        customer_email: 'c@example.com',
        customer_name: 'Cliente Test',
        customer_phone: PHONE,
        lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
      }),
    })
    expect(paid.status).toBe(201)
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
    await arriveAtGrace(folioA) // A is past its grace instant

    const svcB = await seedService(orgB.organizationId)
    const slotB = await seedSlot(orgB.organizationId, svcB)
    const folioB = await createBooking(agentB, slotB) // B keeps its future expiry

    const result = await sweepExpiredBookings(env)
    expect(result).toMatchObject({ cancelled: 1, failed: 0 })

    expect((await getFolio(folioA)).status).toBe('cancelled')
    expect(await getSlotBooked(slotA)).toBe(0)
    expect((await getFolio(folioB)).status).toBe('booking') // untouched
    expect(await getSlotBooked(slotB)).toBe(2)
  })
})
