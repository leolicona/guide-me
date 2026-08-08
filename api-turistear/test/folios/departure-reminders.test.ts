import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearAffiliateDb } from '../helpers/tenancy'
import { sweepDepartureReminders } from '../../src/routes/pos/reminders'

// US-T08 — the departure reminder, and the review request.
// Spec: docs/folios/folio-state-machine.spec.md, Phase 4.
//
// Both are CLOCK-produced, which is what makes them the only two events in this feature that need
// asserting against time rather than against a request. `now` is injected, so every boundary is
// exact instead of approximately right.

const HOUR = 3600
const nowSec = () => Math.floor(Date.now() / 1000)

/** A departure at a wall-clock instant, expressed for a UTC-seeded org (seedUser seeds UTC). */
const utcDay = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10)
const utcTime = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 16)

const seedFolio = async (opts: {
  organizationId: string
  agentId: string
  departsAt: number
  status?: string
  customerEmail?: string | null
  redeemedCount?: number
  paymentVerification?: string
}): Promise<string> => {
  const id = crypto.randomUUID()
  const serviceId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at,
        payment_verification)
     VALUES (?, ?, ?, 'Ana Buceo', ?, '+529981234567', ?, 200000, 0, 200000, 200000, ?, ?, ?)`,
  )
    .bind(
      id, opts.organizationId, opts.agentId, opts.customerEmail ?? null,
      opts.status ?? 'paid', nowSec(), nowSec(),
      opts.paymentVerification ?? 'verified',
    )
    .run()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price,
       default_capacity, status, created_at, updated_at)
     VALUES (?, ?, 'Tour Isla Mujeres', '', 100000, 80000, 30, 'active', ?, ?)`,
  ).bind(serviceId, opts.organizationId, nowSec(), nowSec()).run()
  await env.DB.prepare(
    `INSERT INTO folio_lines
       (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date,
        slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
        qr_token, redeemed_count, created_at)
     VALUES (?, ?, ?, ?, NULL, 'Tour Isla Mujeres', ?, ?, 4, 50000, 50000, 50000, 200000, NULL, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(), opts.organizationId, id, serviceId,
      utcDay(opts.departsAt), utcTime(opts.departsAt),
      opts.redeemedCount ?? 0, nowSec(),
    )
    .run()
  return id
}

const eventsFor = async (folioId: string): Promise<string[]> =>
  (
    (
      await env.DB.prepare(
        `SELECT DISTINCT event FROM notifications WHERE folio_id = ? ORDER BY event`,
      ).bind(folioId).all()
    ).results as Array<{ event: string }>
  ).map((r) => r.event)

beforeEach(clearAffiliateDb)

describe('US-T08 — the departure reminder', () => {
  it('fires at T−24h', async () => {
    const { organizationId, userId } = await seedUser({ email: 'a@e.com', role: 'admin' })
    const departsAt = nowSec() + 24 * HOUR
    const folioId = await seedFolio({ organizationId, agentId: userId, departsAt })

    const r = await sweepDepartureReminders(env as never)
    expect(r.reminded).toBe(1)
    expect(await eventsFor(folioId)).toContain('departure_reminder')
  })

  it('does not fire two days out — the window is a window, not a floor', async () => {
    const { organizationId, userId } = await seedUser({ email: 'a@e.com', role: 'admin' })
    const folioId = await seedFolio({
      organizationId, agentId: userId, departsAt: nowSec() + 48 * HOUR,
    })

    expect((await sweepDepartureReminders(env as never)).reminded).toBe(0)
    expect(await eventsFor(folioId)).toEqual([])
  })

  it('a re-run cannot remind twice — the unique index is the guard', async () => {
    const { organizationId, userId } = await seedUser({ email: 'a@e.com', role: 'admin' })
    const folioId = await seedFolio({
      organizationId, agentId: userId, departsAt: nowSec() + 24 * HOUR,
    })

    await sweepDepartureReminders(env as never)
    await sweepDepartureReminders(env as never)

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE folio_id = ? AND event = 'departure_reminder'`,
    ).bind(folioId).first<{ n: number }>()
    // Two rows total — one per channel — never four.
    expect(rows!.n).toBe(2)
  })

  it('an apartado is not reminded — it has its own notice, and this one omits the balance', async () => {
    const { organizationId, userId } = await seedUser({ email: 'a@e.com', role: 'admin' })
    const folioId = await seedFolio({
      organizationId, agentId: userId, departsAt: nowSec() + 24 * HOUR, status: 'booking',
    })

    expect((await sweepDepartureReminders(env as never)).reminded).toBe(0)
    expect(await eventsFor(folioId)).toEqual([])
  })

  it('an unverified transfer is not reminded — that customer has no tickets yet', async () => {
    const { organizationId, userId } = await seedUser({ email: 'a@e.com', role: 'admin' })
    await seedFolio({
      organizationId, agentId: userId, departsAt: nowSec() + 24 * HOUR,
      paymentVerification: 'pending',
    })
    expect((await sweepDepartureReminders(env as never)).reminded).toBe(0)
  })

  it('D20 — the WhatsApp row is written whether or not there is an email', async () => {
    const { organizationId, userId } = await seedUser({ email: 'a@e.com', role: 'admin' })
    const folioId = await seedFolio({
      organizationId, agentId: userId, departsAt: nowSec() + 24 * HOUR, customerEmail: null,
    })

    await sweepDepartureReminders(env as never)
    const rows = (
      await env.DB.prepare(
        `SELECT channel, status FROM notifications WHERE folio_id = ? ORDER BY channel`,
      ).bind(folioId).all()
    ).results as Array<{ channel: string; status: string }>

    expect(rows.find((r) => r.channel === 'whatsapp')!.status).toBe('pending')
    // `skipped`, not `failed` — no address is "this channel does not apply".
    expect(rows.find((r) => r.channel === 'email')!.status).toBe('skipped')
  })

  it('one message per folio, not one per line', async () => {
    const { organizationId, userId } = await seedUser({ email: 'a@e.com', role: 'admin' })
    const departsAt = nowSec() + 24 * HOUR
    const folioId = await seedFolio({ organizationId, agentId: userId, departsAt })
    // A second line on the SAME folio, departing later.
    const serviceId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price,
         default_capacity, status, created_at, updated_at)
       VALUES (?, ?, 'Chichén', '', 100000, 80000, 30, 'active', ?, ?)`,
    ).bind(serviceId, organizationId, nowSec(), nowSec()).run()
    await env.DB.prepare(
      `INSERT INTO folio_lines
         (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date,
          slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
          qr_token, redeemed_count, created_at)
       VALUES (?, ?, ?, ?, NULL, 'Chichén', ?, ?, 2, 50000, 50000, 50000, 100000, NULL, 0, ?)`,
    )
      .bind(
        crypto.randomUUID(), organizationId, folioId, serviceId,
        utcDay(departsAt + 3 * HOUR), utcTime(departsAt + 3 * HOUR), nowSec(),
      )
      .run()

    const r = await sweepDepartureReminders(env as never)
    // Three messages about one trip is how a number gets blocked.
    expect(r.reminded).toBe(1)
  })
})

describe('US-T08 — the review request', () => {
  it('asks only somebody who actually came', async () => {
    const { organizationId, userId } = await seedUser({ email: 'a@e.com', role: 'admin' })
    const departsAt = nowSec() - 2 * HOUR

    const came = await seedFolio({ organizationId, agentId: userId, departsAt, redeemedCount: 4 })
    const didNot = await seedFolio({ organizationId, agentId: userId, departsAt, redeemedCount: 0 })

    const r = await sweepDepartureReminders(env as never)
    expect(r.reviews).toBe(1)
    expect(await eventsFor(came)).toContain('review_requested')
    // "¿Cómo te fue?" to somebody who never boarded is the worst message in the whitelist, and the
    // fulfilment axis (US-A85) is precisely what makes it avoidable.
    expect(await eventsFor(didNot)).not.toContain('review_requested')
  })

  it('does not fire before the tour is over', async () => {
    const { organizationId, userId } = await seedUser({ email: 'a@e.com', role: 'admin' })
    await seedFolio({
      organizationId, agentId: userId, departsAt: nowSec() + HOUR, redeemedCount: 4,
    })
    expect((await sweepDepartureReminders(env as never)).reviews).toBe(0)
  })
})

describe('Multitenancy isolation', () => {
  it("one org's sweep never emits for another org's folio", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const departsAt = nowSec() + 24 * HOUR
    const a = await seedFolio({
      organizationId: orgA.organizationId, agentId: orgA.adminUserId, departsAt,
    })
    const b = await seedFolio({
      organizationId: orgB.organizationId, agentId: orgB.adminUserId, departsAt,
    })

    await sweepDepartureReminders(env as never)

    // Each row must be stamped with the org that OWNS the folio — a sweep that leaked would write
    // org A's id onto org B's notification and the outbox view would show a stranger's customer.
    for (const [folioId, org] of [
      [a, orgA.organizationId],
      [b, orgB.organizationId],
    ] as const) {
      const row = await env.DB.prepare(
        `SELECT organization_id FROM notifications WHERE folio_id = ? LIMIT 1`,
      ).bind(folioId).first<{ organization_id: string }>()
      expect(row!.organization_id).toBe(org)
    }
  })
})
