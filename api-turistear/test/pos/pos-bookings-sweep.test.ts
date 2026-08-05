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
    `SELECT status, amount_paid, cancellation_reason, refund_status, refund_pin,
            cancellation_source, reminder_status, credit_amount, credit_expires_at
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

  // US-T09 — until now the sweep emitted on ENTERING the grace window and emitted nothing when the
  // hold actually ended, so the customer's last message said their spots were *about to* be
  // released. They never learned that they were, or that their deposit had become revenue.
  it('US-T09 — the close is announced, not just the warning', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    await arriveAtGrace(folioId)

    await sweepExpiredBookings(env)

    const rows = (
      await env.DB.prepare(
        `SELECT channel, status FROM notifications
          WHERE folio_id = ? AND event = 'booking_expired' ORDER BY channel`,
      ).bind(folioId).all()
    ).results as Array<{ channel: string; status: string }>

    // D20 — WhatsApp always, email additionally. This fixture carries `c@example.com`, so both are
    // pending; the no-address case is the next test.
    expect(rows.map((r) => r.channel)).toEqual(['email', 'whatsapp'])
    expect(rows.every((r) => r.status === 'pending')).toBe(true)
  })

  it('US-T09 — with no address on file the WhatsApp row still goes out', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    await env.DB.prepare(`UPDATE folios SET customer_email = NULL WHERE id = ?`).bind(folioId).run()
    await arriveAtGrace(folioId)

    await sweepExpiredBookings(env)

    const rows = (
      await env.DB.prepare(
        `SELECT channel, status FROM notifications
          WHERE folio_id = ? AND event = 'booking_expired' ORDER BY channel`,
      ).bind(folioId).all()
    ).results as Array<{ channel: string; status: string }>

    // `skipped` is "this channel does not apply", which is a different fact from "the provider
    // refused" and must not be counted alongside it. The customer is still reached.
    expect(rows.find((r) => r.channel === 'whatsapp')!.status).toBe('pending')
    expect(rows.find((r) => r.channel === 'email')!.status).toBe('skipped')
  })

  // US-A87 (D6/D8) — the credit exists so that raising the terminal tier becomes USABLE. Before it,
  // a generous tier produced a cash refund somebody had to physically hand to a person who was not
  // there; now it produces something deliverable to an absent customer.
  it('US-A87 — a generous terminal tier leaves a CREDIT, not a cash debt', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    // A terminal tier of 95%. It has to be that generous, and the reason is worth stating because
    // it is not obvious and it decides how often credits appear at all:
    //
    // the ladder retains a share of what was SOLD, not of what was COLLECTED (engine D3), and the
    // refund is `max(0, amountPaid − retention)`. This cart is 2 × 150,000 = 300,000 with a 45,000
    // deposit, so a 40% tier retains 180,000 — more than was ever paid — and leaves NOTHING. That
    // is US-A76 by name: "a 30% deposit against a 50% retention refunds nothing."
    //
    // At 95% the retention is 15,000 and the deposit leaves 30,000 behind.
    await env.DB.prepare(
      `UPDATE organizations SET cancellation_policy = ?, booking_credit_valid_days = 30 WHERE id = ?`,
    )
      .bind(
        JSON.stringify({
          version: 1,
          tiers: [{ min_hours: null, refund_pct: 95, agent_commission_pct: 100 }],
        }),
        organizationId,
      )
      .run()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    await arriveAtGrace(folioId)

    await sweepExpiredBookings(env)

    const row = await getFolio(folioId)
    // 45,000 paid − 15,000 retained.
    expect(row.credit_amount).toBe(30000)
    expect(row.credit_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
    // And NOT a cash obligation: nobody is standing there to receive it, and a refund PIN would be
    // a debt the customer never asked for.
    expect(row.refund_status).toBe('none')
    expect(row.refund_pin).toBeNull()
  })

  it('US-A87 — the inherited default leaves no credit, and no date on nothing', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    await arriveAtGrace(folioId)

    await sweepExpiredBookings(env)

    const row = await getFolio(folioId)
    // US-A76 chose this default deliberately; the credit feature does not make anyone more generous.
    expect(row.credit_amount).toBe(0)
    expect(row.credit_expires_at).toBeNull()
  })

  it('US-T09 — a second run cannot announce the same close twice', async () => {
    const { organizationId } = await seedUser({ email: 'agent@empresa.com', role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking('agent@empresa.com', slotId)
    await arriveAtGrace(folioId)

    await sweepExpiredBookings(env)
    await sweepExpiredBookings(env)

    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE folio_id = ? AND event = 'booking_expired'`,
    ).bind(folioId).first<{ n: number }>()
    // Two rows — one per channel — never four. The unique index is the guard.
    expect(n!.n).toBe(2)
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
