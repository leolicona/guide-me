import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearAffiliateDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-AG52 — reagendar mientras el lugar es tuyo.
// Spec: docs/bookings/booking-reschedule.spec.md — S-1 … S-9b, S-16, S-17.
//
// The property worth defending above all others is S-3: a reschedule that fails must leave the
// customer holding the seat they started with. Refusing is fine; refusing AND taking the seat is
// the one outcome worse than not offering the feature.

const AGENT = 'agent@empresa.com'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const NOW = new Date('2026-06-14T12:00:00Z')
const nowSec = () => Math.floor(NOW.getTime() / 1000)
const dayOffset = (n: number) =>
  new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (organizationId: string, name = 'Tour Isla Mujeres') => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price,
       default_capacity, status, created_at, updated_at)
     VALUES (?, ?, ?, '', 150000, 100000, 30, 'active', ?, ?)`,
  ).bind(id, organizationId, name, nowSec(), nowSec()).run()
  return id
}

const seedSlot = async (opts: {
  organizationId: string
  serviceId: string
  date?: string
  startTime?: string
  capacity?: number
  booked?: number
}) => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, date, start_time, capacity, booked, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
  )
    .bind(
      id, opts.organizationId, opts.serviceId,
      opts.date ?? dayOffset(5), opts.startTime ?? '09:00',
      opts.capacity ?? 20, opts.booked ?? 0,
    )
    .run()
  return id
}

const seedFolio = async (opts: {
  organizationId: string
  agentId: string
  slotId: string
  serviceId: string
  status?: 'booking' | 'paid' | 'cancelled'
  quantity?: number
}) => {
  const folioId = crypto.randomUUID()
  const lineId = crypto.randomUUID()
  const qty = opts.quantity ?? 2
  const slot = await env.DB.prepare(`SELECT date, start_time FROM slots WHERE id = ?`)
    .bind(opts.slotId).first<{ date: string; start_time: string }>()

  await env.DB.prepare(
    `INSERT INTO folios (id, organization_id, agent_id, customer_name, customer_email,
       customer_phone, status, subtotal, discount_total, total, amount_paid, created_at,
       updated_at, booking_expires_at, payment_verification)
     VALUES (?, ?, ?, 'Ana Buceo', 'ana@x.com', '+529981234567', ?, 300000, 0, 300000, ?, ?, ?, ?, 'verified')`,
  )
    .bind(
      folioId, opts.organizationId, opts.agentId, opts.status ?? 'booking',
      opts.status === 'paid' ? 300000 : 90000, nowSec(), nowSec(),
      opts.status === 'booking' ? nowSec() + 86_400 : null,
    )
    .run()
  await env.DB.prepare(
    `INSERT INTO folio_lines (id, organization_id, folio_id, service_id, slot_id, service_name,
       slot_date, slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
       qr_token, redeemed_count, created_at)
     VALUES (?, ?, ?, ?, ?, 'Tour Isla Mujeres', ?, ?, ?, 150000, 100000, 150000, 300000, 'tok-old', 0, ?)`,
  )
    .bind(
      lineId, opts.organizationId, folioId, opts.serviceId, opts.slotId,
      slot!.date, slot!.start_time, qty, nowSec(),
    )
    .run()
  await env.DB.prepare(`UPDATE slots SET booked = booked + ? WHERE id = ?`)
    .bind(qty, opts.slotId).run()
  return { folioId, lineId }
}

const reschedule = (email: string, folioId: string, moves: unknown[]) =>
  SELF.fetch(`http://api.local/api/pos/folios/${folioId}/reschedule`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ moves }),
  })

const booked = async (slotId: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(slotId)
    .first<{ booked: number }>())!.booked

const line = (id: string) =>
  env.DB.prepare(`SELECT slot_id, slot_date, slot_start_time FROM folio_lines WHERE id = ?`)
    .bind(id).first<any>()

beforeEach(async () => {
  await clearAffiliateDb()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('US-AG52 — a live apartado moves to another departure', () => {
  it('S-1 — the seats move, and the deadline follows the new earliest departure', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId, date: dayOffset(5) })
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(9) })
    const { folioId, lineId } = await seedFolio({ organizationId, agentId: userId, slotId: from, serviceId })

    expect(await booked(from)).toBe(2)
    const res = await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])
    expect(res.status).toBe(200)

    expect(await booked(from)).toBe(0)
    expect(await booked(to)).toBe(2)
    expect((await line(lineId)).slot_date).toBe(dayOffset(9))

    // D17 — recomputed from the new departure, so "pagas 24 h antes de tu primer tour" stays true.
    const folio = await env.DB.prepare(`SELECT booking_expires_at, status FROM folios WHERE id = ?`)
      .bind(folioId).first<any>()
    expect(folio.status).toBe('booking')
    const expected = Math.floor(new Date(`${dayOffset(9)}T09:00:00Z`).getTime() / 1000) - 86_400
    expect(folio.booking_expires_at).toBe(expected)
  })

  it('S-2 — no money moves', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId })
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(9) })
    const { folioId, lineId } = await seedFolio({ organizationId, agentId: userId, slotId: from, serviceId })

    await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])

    const folio = await env.DB.prepare(
      `SELECT amount_paid, commission_amount, cancellation_policy_snapshot FROM folios WHERE id = ?`,
    ).bind(folioId).first<any>()
    expect(folio.amount_paid).toBe(90000)
    expect(folio.commission_amount).toBe(0)
    const payments = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM folio_payments WHERE folio_id = ?`,
    ).bind(folioId).first<{ n: number }>()
    // A reschedule moves a DATE. The ladder never runs.
    expect(payments!.n).toBe(0)
  })

  it('S-3 — a full destination refuses, and the SOURCE still holds the seats', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId })
    // Capacity 2, already full.
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(9), capacity: 2, booked: 2 })
    const { folioId, lineId } = await seedFolio({ organizationId, agentId: userId, slotId: from, serviceId })

    const res = await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('NO_CAPACITY_AVAILABLE')

    // THE assertion of this file: refusing is fine, refusing and taking the seat is not.
    expect(await booked(from)).toBe(2)
    expect(await booked(to)).toBe(2)
    expect((await line(lineId)).slot_id).toBe(from)
  })

  // S-3 with ONE line proves the source is untouched, but it cannot prove the COMPENSATION: with a
  // single move, nothing was taken before the failure, so `releaseTaken()` is a no-op and deleting
  // it changes nothing. Found by mutating it. Two lines is the smallest case that has teeth.
  it('S-3b — a partial failure gives back every seat it had already taken', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const fromA = await seedSlot({ organizationId, serviceId, startTime: '09:00' })
    const fromB = await seedSlot({ organizationId, serviceId, startTime: '11:00' })
    const okDest = await seedSlot({ organizationId, serviceId, date: dayOffset(9), startTime: '09:00' })
    const fullDest = await seedSlot({
      organizationId, serviceId, date: dayOffset(9), startTime: '11:00', capacity: 2, booked: 2,
    })

    const { folioId, lineId } = await seedFolio({ organizationId, agentId: userId, slotId: fromA, serviceId })
    // A second line on the same folio, departing later.
    const lineB = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO folio_lines (id, organization_id, folio_id, service_id, slot_id, service_name,
         slot_date, slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
         qr_token, redeemed_count, created_at)
       VALUES (?, ?, ?, ?, ?, 'Tour Isla Mujeres', ?, '11:00', 2, 150000, 100000, 150000, 300000, NULL, 0, ?)`,
    ).bind(lineB, organizationId, folioId, serviceId, fromB, dayOffset(5), nowSec()).run()
    await env.DB.prepare(`UPDATE slots SET booked = booked + 2 WHERE id = ?`).bind(fromB).run()

    const res = await reschedule(AGENT, folioId, [
      { folio_line_id: lineId, to_slot_id: okDest },   // this one succeeds…
      { folio_line_id: lineB, to_slot_id: fullDest },  // …and then this one cannot
    ])
    expect(res.status).toBe(409)

    // The seats the FIRST move already took must be back in the pool — otherwise a failed
    // reschedule quietly holds inventory nobody bought.
    expect(await booked(okDest)).toBe(0)
    // And both sources are intact: the customer still has exactly what they started with.
    expect(await booked(fromA)).toBe(2)
    expect(await booked(fromB)).toBe(2)
    expect((await line(lineId)).slot_id).toBe(fromA)
  })

  it('S-4 — a different service is refused', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const otherService = await seedService(organizationId, 'Chichén Itzá')
    const from = await seedSlot({ organizationId, serviceId })
    const to = await seedSlot({ organizationId, serviceId: otherService, date: dayOffset(9) })
    const { folioId, lineId } = await seedFolio({ organizationId, agentId: userId, slotId: from, serviceId })

    const res = await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('DIFFERENT_SERVICE')
    expect(await booked(from)).toBe(2)
  })

  it('S-5 — the destination cannot be inside the apartado creation cutoff', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    // Legal since BUG-029: at 12 h out the near branch gives the apartado salida−15min.
    await env.DB.prepare(
      `UPDATE organizations SET booking_creation_cutoff_hours = 12 WHERE id = ?`,
    ).bind(organizationId).run()
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId })
    // Six hours out.
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(0), startTime: '18:00' })
    const { folioId, lineId } = await seedFolio({ organizationId, agentId: userId, slotId: from, serviceId })

    const res = await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('BOOKING_TOO_LATE')
  })

  it('S-5b — a reschedule cannot write a hold that is already over', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    // creation cutoff 0 (the shipped default) — the guard above does not run at all.
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId })
    // Ten minutes out, grace +15: the recomputed expiry is five minutes in the PAST.
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(0), startTime: '12:10' })
    const { folioId, lineId } = await seedFolio({ organizationId, agentId: userId, slotId: from, serviceId })

    const res = await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('BOOKING_TOO_LATE')
    expect(await booked(from)).toBe(2)
  })

  it('S-7 — only a live apartado or a paid sale', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId })
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(9) })
    const { folioId, lineId } = await seedFolio({
      organizationId, agentId: userId, slotId: from, serviceId, status: 'cancelled',
    })

    const res = await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('NOT_RESCHEDULABLE')
  })

  it('S-8 — the agreement is recorded, with the seller’s name on it', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId })
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(9) })
    const { folioId, lineId } = await seedFolio({ organizationId, agentId: userId, slotId: from, serviceId })

    await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])

    const row = await env.DB.prepare(
      `SELECT kind, status, from_slot_id, to_slot_id, resolved_by FROM folio_requests WHERE folio_id = ?`,
    ).bind(folioId).first<any>()
    expect(row.kind).toBe('reschedule')
    // D13b — a counter reschedule is created and resolved in one instant, so it never touches the
    // partial index and cannot collide with a tourist's open petition.
    expect(row.status).toBe('approved')
    expect(row.from_slot_id).toBe(from)
    expect(row.to_slot_id).toBe(to)
    expect(row.resolved_by).toBe(userId)
  })

  it('S-9 — the new deadline gets its own warning', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId })
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(9) })
    const { folioId, lineId } = await seedFolio({ organizationId, agentId: userId, slotId: from, serviceId })

    // The folio has already been warned once for the OLD deadline.
    await env.DB.prepare(`UPDATE folios SET reminder_status = 'sent' WHERE id = ?`).bind(folioId).run()
    await env.DB.prepare(
      `INSERT INTO notifications (id, organization_id, folio_id, event, channel, status)
       VALUES (?, ?, ?, 'booking_grace_entered', 'whatsapp', 'sent')`,
    ).bind(crypto.randomUUID(), organizationId, folioId).run()

    await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])

    const folio = await env.DB.prepare(`SELECT reminder_status FROM folios WHERE id = ?`)
      .bind(folioId).first<{ reminder_status: string }>()
    // Keeping the flag is exactly what makes the second cycle silent today.
    expect(folio!.reminder_status).toBe('none')

    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE folio_id = ? AND event = 'booking_grace_entered'`,
    ).bind(folioId).first<{ n: number }>()
    // The rows for the closed cycle go too, or the unique index blocks the new warning.
    expect(n!.n).toBe(0)
  })
})

describe('US-AG52 — a PAID folio moves, and its ticket moves with it (D16)', () => {
  it('S-8b — the tickets_delivered rows are cleared and re-emitted', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId })
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(9) })
    const { folioId, lineId } = await seedFolio({
      organizationId, agentId: userId, slotId: from, serviceId, status: 'paid',
    })
    await env.DB.prepare(
      `INSERT INTO notifications (id, organization_id, folio_id, event, channel, status)
       VALUES (?, ?, ?, 'tickets_delivered', 'whatsapp', 'sent')`,
    ).bind(crypto.randomUUID(), organizationId, folioId).run()

    const res = await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])
    expect(res.status).toBe(200)

    const rows = (
      await env.DB.prepare(
        `SELECT channel, status FROM notifications WHERE folio_id = ? AND event = 'tickets_delivered'
          ORDER BY channel`,
      ).bind(folioId).all()
    ).results as Array<{ channel: string; status: string }>
    // The old row is gone and a fresh pair is pending — the customer is holding a ticket for a
    // departure that no longer exists, and the replacement has to reach them.
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'pending')).toBe(true)

    const folio = await env.DB.prepare(`SELECT amount_paid, status FROM folios WHERE id = ?`)
      .bind(folioId).first<any>()
    expect(folio.status).toBe('paid')
    expect(folio.amount_paid).toBe(300000)
  })

  it('S-8b(ii) — the QR is RE-SIGNED, not merely re-announced', async () => {
    const { organizationId, userId } = await seedUser({ email: AGENT, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const from = await seedSlot({ organizationId, serviceId })
    const to = await seedSlot({ organizationId, serviceId, date: dayOffset(20) })
    const { folioId, lineId } = await seedFolio({
      organizationId, agentId: userId, slotId: from, serviceId, status: 'paid',
    })

    await reschedule(AGENT, folioId, [{ folio_line_id: lineId, to_slot_id: to }])

    const row = await env.DB.prepare(`SELECT qr_token FROM folio_lines WHERE id = ?`)
      .bind(lineId).first<{ qr_token: string | null }>()
    // The old token is gone. Announcing a new date on a ticket that still carries the OLD one is
    // the failure this catches: `expires_at` lives INSIDE the signed payload and was derived from
    // the previous departure, so a ticket moved further out would die before the tour it is for.
    expect(row!.qr_token).not.toBe('tok-old')
    expect(row!.qr_token).toBeTruthy()
  })
})

describe('Multitenancy isolation', () => {
  it("S-16 — another org's folio cannot be rescheduled", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceB = await seedService(orgB.organizationId)
    const fromB = await seedSlot({ organizationId: orgB.organizationId, serviceId: serviceB })
    const toB = await seedSlot({
      organizationId: orgB.organizationId, serviceId: serviceB, date: dayOffset(9),
    })
    const { folioId, lineId } = await seedFolio({
      organizationId: orgB.organizationId, agentId: orgB.adminUserId, slotId: fromB, serviceId: serviceB,
    })

    const res = await reschedule(orgA.adminEmail, folioId, [
      { folio_line_id: lineId, to_slot_id: toB },
    ])
    // 404, never 403 — a 403 confirms the folio exists.
    expect(res.status).toBe(404)
    expect(await booked(fromB)).toBe(2)
    expect(await booked(toB)).toBe(0)
  })

  it("S-17 — a destination slot in another org is not a destination", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceA = await seedService(orgA.organizationId)
    const fromA = await seedSlot({ organizationId: orgA.organizationId, serviceId: serviceA })
    const serviceB = await seedService(orgB.organizationId)
    const toB = await seedSlot({ organizationId: orgB.organizationId, serviceId: serviceB })
    const { folioId, lineId } = await seedFolio({
      organizationId: orgA.organizationId, agentId: orgA.adminUserId, slotId: fromA, serviceId: serviceA,
    })

    const res = await reschedule(orgA.adminEmail, folioId, [
      { folio_line_id: lineId, to_slot_id: toB },
    ])
    expect(res.status).toBe(404)
    expect(await booked(fromA)).toBe(2)
    expect(await booked(toB)).toBe(0)
  })
})
