import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import { sweepExpiredBookings } from '../../src/routes/pos/sweep'
// @ts-expect-error — vite's ?raw import; the test replays the migration's backfill INSERTs (S-5).
import migrationSql from '../../migrations/0061_folio_events.sql?raw'

// US-A24 / US-AG53 — the folio timeline: every sale can tell its own story.
// Spec: docs/folios/folio-timeline.spec.md (S-1…S-6, S-8, S-9; S-7's UI half lives in the app).
//
// What is worth asserting here: the narrative rows land ATOMICALLY with their mutations (driven
// through the real endpoints, never inserted by hand), the backfill recovers a pre-migration
// folio's history from the columns that survive, and the story is invisible across org and
// seller boundaries.

const AGENT_EMAIL = 'agent@empresa.com'
const OTHER_AGENT_EMAIL = 'otro@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const POS = 'http://api.local/api/pos'
const FOLIOS = 'http://api.local/api/folios'

const nowSec = () => Math.floor(Date.now() / 1000)
const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

interface FolioEventOut {
  id: string
  type: string
  at: number
  actor: { id: string; name: string | null } | null
  operator_name: string | null
  backfilled: boolean
  payload: Record<string, unknown> | null
}

const seedService = async (organizationId: string): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', 0, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, ts, ts)
    .run()
  return { serviceId }
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  date: string,
): Promise<{ slotId: string }> => {
  const slotId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, date, ts, ts)
    .run()
  return { slotId }
}

const createBooking = async (email: string, slotId: string, deposit = 45000): Promise<string> => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_email: 'cliente@example.com',
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      down_payment: deposit,
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}

const createTransferSale = async (email: string, slotId: string, reference: string): Promise<string> => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_email: 'cliente@example.com',
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      payment_method: 'transfer',
      payment_reference: reference,
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}

const post = async (email: string, url: string, body?: unknown) => {
  const res = await SELF.fetch(url, {
    method: 'POST',
    headers: jsonAuth(email),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const adminDetailEvents = async (folioId: string, email = ADMIN_EMAIL): Promise<FolioEventOut[]> => {
  const res = await SELF.fetch(`${FOLIOS}/${folioId}`, { headers: auth(email) })
  expect(res.status).toBe(200)
  const json = (await res.json()) as { events: FolioEventOut[] }
  return json.events
}

const clearDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_requests')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folio_events')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

/** Seed the agent + an admin in the SAME org, plus a service with two future departures. */
const seedStage = async () => {
  const agent = await seedUser({ email: AGENT_EMAIL, role: 'agent', name: 'Ana R.' })
  const admin = await seedUser({
    email: ADMIN_EMAIL,
    role: 'admin',
    name: 'Luis M.',
    organizationId: agent.organizationId,
  })
  const { serviceId } = await seedService(agent.organizationId)
  const slotA = await seedSlot(agent.organizationId, serviceId, addDays(todayStr(), 3))
  const slotB = await seedSlot(agent.organizationId, serviceId, addDays(todayStr(), 5))
  return {
    organizationId: agent.organizationId,
    agentId: agent.userId,
    adminId: admin.userId,
    serviceId,
    slotA: slotA.slotId,
    slotB: slotB.slotId,
  }
}

describe('US-A24 — the admin reads the sale as a story', () => {
  it("S-1 — an apartado's full journey reads in order, with actors resolved", async () => {
    const stage = await seedStage()
    const folioId = await createBooking(AGENT_EMAIL, stage.slotA)

    const remind = await post(AGENT_EMAIL, `${POS}/folios/${folioId}/reminder`)
    expect(remind.status).toBe(200)
    const settle = await post(AGENT_EMAIL, `${POS}/folios/${folioId}/settle`)
    expect(settle.status).toBe(200)
    const sent = await post(AGENT_EMAIL, `${POS}/folios/${folioId}/ticket-delivery`)
    expect(sent.status).toBe(200)

    const events = await adminDetailEvents(folioId)
    expect(events.map((e) => e.type)).toEqual([
      'created',
      'payment',
      'reminder_sent',
      'payment',
      'tickets_sent',
    ])
    const [created, deposit, , settlement] = events
    expect(created.actor).toMatchObject({ id: stage.agentId, name: 'Ana R.' })
    expect(created.payload).toMatchObject({ sale_mode: 'standard', initial_status: 'booking' })
    expect(deposit.payload).toMatchObject({ amount: 45000, method: 'cash', kind: 'deposit' })
    expect(settlement.payload).toMatchObject({ amount: 255000, kind: 'settlement' })
    expect(events.every((e) => e.backfilled === false)).toBe(true)
  })

  it("S-2 — the sweep's cancellation names the system", async () => {
    const stage = await seedStage()
    const folioId = await createBooking(AGENT_EMAIL, stage.slotA)

    // Past the GRACE instant: the sweep reads each line's snapshotted departure, so the line is
    // what has to move (the pos-bookings-sweep pattern; test orgs run in UTC).
    const now = new Date()
    await env.DB.prepare(
      `UPDATE folio_lines SET slot_date = ?, slot_start_time = ? WHERE folio_id = ?`,
    )
      .bind(now.toISOString().slice(0, 10), now.toISOString().slice(11, 16), folioId)
      .run()
    await env.DB.prepare(`UPDATE folios SET booking_expires_at = ? WHERE id = ?`)
      .bind(nowSec() - 60, folioId)
      .run()
    // Since line-autonomy F3 (D5) elapsed time lives in the LINE's clock too.
    await env.DB.prepare(`UPDATE folio_lines SET booking_expires_at = ? WHERE folio_id = ?`)
      .bind(nowSec() - 60, folioId)
      .run()

    const result = await sweepExpiredBookings(env)
    expect(result).toMatchObject({ failed: 0 })
    expect(result.cancelled).toBeGreaterThanOrEqual(1)

    const events = await adminDetailEvents(folioId)
    const cancelled = events.find((e) => e.type === 'cancelled')
    expect(cancelled).toBeDefined()
    expect(cancelled!.actor).toBeNull() // renders "Sistema"
    expect(cancelled!.payload).toMatchObject({ source: 'system_expiry' })
  })

  it('S-3 — a counter reschedule finally leaves a trace', async () => {
    const stage = await seedStage()
    const folioId = await createBooking(AGENT_EMAIL, stage.slotA)
    const line = await env.DB.prepare('SELECT id FROM folio_lines WHERE folio_id = ?')
      .bind(folioId)
      .first<{ id: string }>()

    const moved = await post(AGENT_EMAIL, `${POS}/folios/${folioId}/reschedule`, {
      moves: [{ folio_line_id: line!.id, to_slot_id: stage.slotB }],
    })
    expect(moved.status, JSON.stringify(moved.json)).toBe(200)

    const events = await adminDetailEvents(folioId)
    const reschedule = events.find((e) => e.type === 'rescheduled')
    expect(reschedule).toBeDefined()
    expect(reschedule!.actor).toMatchObject({ id: stage.agentId })
    expect(reschedule!.payload).toMatchObject({
      origin: 'counter',
      from_date: addDays(todayStr(), 3),
      to_date: addDays(todayStr(), 5),
    })
  })

  it('S-4 — one tap, one row: a rejected transfer narrates as transfer_rejected only', async () => {
    const stage = await seedStage()
    const folioId = await createTransferSale(AGENT_EMAIL, stage.slotA, 'REF-777')

    const rejected = await post(ADMIN_EMAIL, `${POS}/folios/${folioId}/reject`, {
      reason: 'La transferencia nunca llegó',
    })
    expect(rejected.status, JSON.stringify(rejected.json)).toBe(200)

    const events = await adminDetailEvents(folioId)
    const types = events.map((e) => e.type)
    expect(types.filter((t) => t === 'transfer_rejected')).toHaveLength(1)
    expect(types).not.toContain('cancelled')
    const rejection = events.find((e) => e.type === 'transfer_rejected')!
    expect(rejection.actor).toMatchObject({ id: stage.adminId, name: 'Luis M.' })
    expect(rejection.payload).toMatchObject({
      reference: 'REF-777',
      reason: 'La transferencia nunca llegó',
    })

    const folio = await env.DB.prepare('SELECT status FROM folios WHERE id = ?')
      .bind(folioId)
      .first<{ status: string }>()
    expect(folio!.status).toBe('cancelled')
  })

  it('S-4b — a verified transfer narrates who cleared the money', async () => {
    const stage = await seedStage()
    const folioId = await createTransferSale(AGENT_EMAIL, stage.slotA, 'REF-888')

    const verified = await post(ADMIN_EMAIL, `${POS}/folios/${folioId}/verify`)
    expect(verified.status, JSON.stringify(verified.json)).toBe(200)

    const events = await adminDetailEvents(folioId)
    const verification = events.find((e) => e.type === 'payment_verified')
    expect(verification).toBeDefined()
    expect(verification!.actor).toMatchObject({ id: stage.adminId, name: 'Luis M.' })
    expect(verification!.payload).toMatchObject({ reference: 'REF-888' })
  })

  it('S-6 — the settlement event and settled_at share one clock', async () => {
    const stage = await seedStage()
    const folioId = await createBooking(AGENT_EMAIL, stage.slotA)
    const settle = await post(AGENT_EMAIL, `${POS}/folios/${folioId}/settle`)
    expect(settle.status).toBe(200)

    const folio = await env.DB.prepare('SELECT settled_at FROM folios WHERE id = ?')
      .bind(folioId)
      .first<{ settled_at: number }>()
    const event = await env.DB.prepare(
      `SELECT created_at FROM folio_events
       WHERE folio_id = ? AND event_type = 'payment' AND payload LIKE '%settlement%'`,
    )
      .bind(folioId)
      .first<{ created_at: number }>()
    expect(event!.created_at).toBe(folio!.settled_at)
  })
})

describe('US-A24 — the backfill recovers a pre-migration history (S-5)', () => {
  it('S-5 — synthetic rows carry the source timestamps; traceless transitions stay absent', async () => {
    const { organizationId, agentId, adminId, slotA, slotB } = await seedStage()

    const T1 = nowSec() - 10 * 86400 // created + deposit
    const T2 = nowSec() - 4 * 86400 // cancelled
    const T3 = nowSec() - 2 * 86400 // refunded (PIN — no note)
    const T4 = nowSec() - 6 * 86400 // an approved reschedule petition

    const folioId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO folios
         (id, organization_id, agent_id, customer_name, status, subtotal, discount_total, total,
          amount_paid, created_at, updated_at, cancelled_at, cancelled_by, cancellation_source,
          cancellation_reason, cancellation_clawback, refund_status, refund_amount, refunded_at,
          refunded_by, refund_note)
       VALUES (?, ?, ?, 'John Diver', 'cancelled', 150000, 0, 150000, 150000, ?, ?, ?, ?, 'admin',
               'Cliente no puede viajar', 0, 'refunded', 150000, ?, ?, NULL)`,
    )
      .bind(folioId, organizationId, agentId, T1, T1, T2, adminId, T3, adminId)
      .run()
    await env.DB.prepare(
      `INSERT INTO folio_payments (id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at)
       VALUES (?, ?, ?, 'payment', 150000, 'cash', 'not_required', ?, ?)`,
    )
      .bind(crypto.randomUUID(), organizationId, folioId, agentId, T1)
      .run()
    await env.DB.prepare(
      `INSERT INTO folio_requests (id, organization_id, folio_id, kind, status, from_slot_id, to_slot_id, resolved_by, resolved_at, created_at, updated_at)
       VALUES (?, ?, ?, 'reschedule', 'approved', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), organizationId, folioId, slotA, slotB, agentId, T4, T4, T4)
      .run()

    // The live writes above (seedStage's users) wrote nothing for this hand-seeded folio, but be
    // explicit: the backfill must start from an empty narrative, as migration 0061 does.
    await env.DB.exec('DELETE FROM folio_events')

    // Replay the migration's backfill INSERTs verbatim — the test breaks if the mapping does.
    const inserts = (migrationSql as string)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--')) // comments carry semicolons; strip BEFORE splitting
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('INSERT INTO folio_events'))
    expect(inserts.length).toBeGreaterThanOrEqual(8)
    for (const stmt of inserts) {
      await env.DB.prepare(stmt).run()
    }

    const events = await adminDetailEvents(folioId)
    expect(events.map((e) => e.type)).toEqual([
      'created',
      'payment',
      'rescheduled',
      'cancelled',
      'refund_confirmed',
    ])
    expect(events.every((e) => e.backfilled === true)).toBe(true)

    const [created, payment, reschedule, cancelled, refund] = events
    expect(created.at).toBe(T1)
    expect(payment.at).toBe(T1)
    expect(payment.payload).toMatchObject({ amount: 150000, method: 'cash' })
    expect(payment.payload).not.toHaveProperty('kind') // unknowable retroactively
    expect(reschedule.at).toBe(T4)
    expect(reschedule.payload).toMatchObject({
      from_date: addDays(todayStr(), 3),
      to_date: addDays(todayStr(), 5),
    })
    expect(reschedule.payload).not.toHaveProperty('origin') // unknowable retroactively
    expect(cancelled.at).toBe(T2)
    expect(cancelled.actor).toMatchObject({ id: adminId })
    expect(cancelled.payload).toMatchObject({
      source: 'admin',
      reason: 'Cliente no puede viajar',
    })
    expect(refund.at).toBe(T3)
    expect(refund.payload).toMatchObject({ amount: 150000, via: 'pin' })
  })
})

describe('US-AG53 — the seller reads the same story, inside the same fences', () => {
  it('S-7 (API half) — the seller sees byte-identical events on their own sale', async () => {
    const stage = await seedStage()
    const folioId = await createTransferSale(AGENT_EMAIL, stage.slotA, 'REF-999')
    await post(ADMIN_EMAIL, `${POS}/folios/${folioId}/verify`)

    const adminEvents = await adminDetailEvents(folioId)
    const res = await SELF.fetch(`${POS}/folios/${folioId}`, { headers: auth(AGENT_EMAIL) })
    expect(res.status).toBe(200)
    const sellerEvents = ((await res.json()) as { events: FolioEventOut[] }).events

    expect(sellerEvents).toEqual(adminEvents)
  })

  it("S-8 — another seller's folio stays invisible, events included", async () => {
    const stage = await seedStage()
    await seedUser({
      email: OTHER_AGENT_EMAIL,
      role: 'agent',
      organizationId: stage.organizationId,
    })
    const folioId = await createBooking(AGENT_EMAIL, stage.slotA)

    const res = await SELF.fetch(`${POS}/folios/${folioId}`, { headers: auth(OTHER_AGENT_EMAIL) })
    expect(res.status).toBe(404)
  })
})

describe('Multitenancy isolation (S-9)', () => {
  it("S-9 — another org's narrative is invisible: 404, never 403", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const folioId = crypto.randomUUID()
    const ts = nowSec()
    await env.DB.prepare(
      `INSERT INTO folios (id, organization_id, agent_id, customer_name, status, subtotal, discount_total, total, amount_paid, created_at, updated_at)
       VALUES (?, ?, ?, 'Cliente B', 'paid', 150000, 0, 150000, 150000, ?, ?)`,
    )
      .bind(folioId, orgB.organizationId, orgB.adminUserId, ts, ts)
      .run()
    await env.DB.prepare(
      `INSERT INTO folio_events (id, organization_id, folio_id, event_type, actor_id, payload, backfilled, created_at)
       VALUES (?, ?, ?, 'created', ?, NULL, 0, ?)`,
    )
      .bind(crypto.randomUUID(), orgB.organizationId, folioId, orgB.adminUserId, ts)
      .run()

    const res = await SELF.fetch(`${FOLIOS}/${folioId}`, { headers: auth(orgA.adminEmail) })
    expect(res.status).toBe(404)

    const posRes = await SELF.fetch(`${POS}/folios/${folioId}`, { headers: auth(orgA.adminEmail) })
    expect(posRes.status).toBe(404)
  })
})
