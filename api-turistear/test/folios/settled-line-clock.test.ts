import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { sessionCookie } from '../helpers/session'
import { sweepExpiredBookings } from '../../src/routes/pos/sweep'

// bug: settled-line-clock-expiry (.specify/bugs/settled-line-clock-expiry/assessment.md).
//
// Since line autonomy (F3, D5) a line can be paid in full while its folio is still an apartado, and
// no settle path clears the line's hold clock. Every reader that took "the live lines' clocks"
// read that PAID line as an expired hold: the sweep cancelled it as "Apartado vencido" (a paid
// tour), the whole-folio settle answered BOOKING_EXPIRED while the owing line's hold had days left,
// and the list flagged the row overdue where the Vencidos facet did not. A line holds while it is
// live AND still owes — the predicate overdueFilter and the sweep's `due` query already used.
//
// The stage is line-settle.test.ts's S-2 cart: a near line (+3 d) and a far line (+10 d), held with
// a deposit; the near line is then settled in full, and time moves on.

const AGENT = 'agent@empresa.com'
const ADMIN = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: sessionCookie(email) })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const POS = 'http://api.local/api/pos'

const nowSec = () => Math.floor(Date.now() / 1000)
const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

beforeEach(async () => {
  for (const t of [
    'folio_line_extras',
    'folio_requests',
    'folio_lines',
    'folio_access_tokens',
    'folio_payments',
    'notifications',
    'folio_events',
    'folios',
    'slots',
    'services',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
  await clearTenancyDb()
})

interface Stage {
  organizationId: string
  agent: string
  serviceId: string
  slotNear: string
  slotFar: string
}

const seedSlot = async (organizationId: string, serviceId: string, date: string) => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '09:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, date, nowSec(), nowSec())
    .run()
  return id
}

const seedStage = async (agent = AGENT, organizationId?: string): Promise<Stage> => {
  const user = await seedUser({ email: agent, role: 'agent', name: 'Ana R.', organizationId })
  await env.DB.prepare(`UPDATE organizations SET booking_min_down_payment_pct = 30 WHERE id = ?`)
    .bind(user.organizationId)
    .run()
  const serviceId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 100000, 25000, 12, 'percent', 1000, 'active', ?, ?)`,
  )
    .bind(serviceId, user.organizationId, nowSec(), nowSec())
    .run()
  return {
    organizationId: user.organizationId,
    agent,
    serviceId,
    slotNear: await seedSlot(user.organizationId, serviceId, addDays(todayStr(), 3)),
    slotFar: await seedSlot(user.organizationId, serviceId, addDays(todayStr(), 10)),
  }
}

const post = async (email: string, path: string, body: unknown = {}) => {
  const res = await SELF.fetch(`${POS}${path}`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const line = async (id: string) =>
  (await env.DB.prepare(`SELECT * FROM folio_lines WHERE id = ?`).bind(id).first()) as Record<
    string,
    any
  >

const outbox = async (folioId: string) =>
  (
    await env.DB.prepare(
      `SELECT event, folio_line_id, organization_id FROM notifications WHERE folio_id = ? AND channel = 'whatsapp'`,
    )
      .bind(folioId)
      .all<{ event: string; folio_line_id: string | null; organization_id: string }>()
  ).results

/**
 * A mixed apartado: near line settled in full and since departed, its never-cleared clock in the
 * past; the far line still owes, departing in ten days.
 */
const mixedApartado = async (stage: Stage, farClock: 'future' | 'past') => {
  const created = await post(stage.agent, '/folios', {
    customer_name: 'Cliente Test',
    customer_phone: PHONE,
    down_payment: 60000,
    lines: [
      { slot_id: stage.slotNear, quantity: 1, unit_price: 100000 },
      { slot_id: stage.slotFar, quantity: 1, unit_price: 50000 },
    ],
  })
  expect(created.status, JSON.stringify(created.json)).toBe(201)
  const folio = created.json.folio
  const near = folio.lines.find((l: any) => l.slot_id === stage.slotNear)
  const far = folio.lines.find((l: any) => l.slot_id === stage.slotFar)

  const settled = await post(stage.agent, `/folios/${folio.id}/lines/${near.id}/settle`)
  expect(settled.status, JSON.stringify(settled.json)).toBe(200)

  // Time passes: the near tour departed this morning, and its stale clock is an hour old.
  await env.DB.prepare(
    `UPDATE folio_lines SET slot_date = ?, slot_start_time = '06:00', booking_expires_at = ? WHERE id = ?`,
  )
    .bind(todayStr(), nowSec() - 3600, near.id)
    .run()
  if (farClock === 'past') {
    await env.DB.prepare(`UPDATE folio_lines SET booking_expires_at = ? WHERE id = ?`)
      .bind(nowSec() - 60, far.id)
      .run()
  }
  expect(Number((await line(near.id)).booking_expires_at)).toBeLessThan(nowSec())
  return { folio, near, far }
}

describe('bug: settled-line-clock-expiry — a line paid in full holds nothing', () => {
  it('R1 — the sweep never cancels the paid line; the owing one in grace is warned', async () => {
    const stage = await seedStage()
    const { folio, near, far } = await mixedApartado(stage, 'past')

    const result = await sweepExpiredBookings(env)

    expect(result).toEqual({ notified: 0, cancelled: 0, failed: 0 }) // no address on file: no email
    expect((await line(near.id)).cancelled_at).toBeNull()
    expect((await line(far.id)).cancelled_at).toBeNull()
    const events = await outbox(folio.id)
    expect(events.filter((e) => e.event === 'booking_expired')).toEqual([])
    // The far line expired and departs in ten days: stage ②. Its warning is what the paid line's
    // false cancellation used to swallow (the run `continue`d past it).
    expect(events.filter((e) => e.event === 'booking_grace_entered')).toHaveLength(1)
  })

  it('R1b — when the owing line reaches its own grace instant, ONLY it is cancelled', async () => {
    const stage = await seedStage()
    const { folio, near, far } = await mixedApartado(stage, 'past')
    await env.DB.prepare(`UPDATE folio_lines SET slot_date = ?, slot_start_time = '06:00' WHERE id = ?`)
      .bind(todayStr(), far.id)
      .run()

    const result = await sweepExpiredBookings(env)

    expect(result.cancelled).toBe(1)
    expect((await line(near.id)).cancelled_at).toBeNull()
    expect((await line(far.id)).cancellation_source).toBe('system_expiry')
    const expired = (await outbox(folio.id)).filter((e) => e.event === 'booking_expired')
    expect(expired.map((e) => e.folio_line_id)).toEqual([far.id])
  })

  it('R2 — the whole-folio settle reads the owing line\'s hold, not the paid line\'s clock', async () => {
    const stage = await seedStage()
    const { folio } = await mixedApartado(stage, 'future')

    const res = await post(stage.agent, `/folios/${folio.id}/settle`)

    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.folio.status).toBe('paid')
  })

  it('R3 — the list row, the Vencidos facet and its count agree, both ways', async () => {
    const stage = await seedStage()
    await seedUser({ email: ADMIN, role: 'admin', organizationId: stage.organizationId })
    const { folio, far } = await mixedApartado(stage, 'future')

    const sellerRow = async () => {
      const res = await SELF.fetch(`${POS}/folios`, { headers: auth(AGENT) })
      const json = (await res.json()) as any
      return (json.folios ?? json).find((f: any) => f.id === folio.id)
    }
    const adminView = async () => {
      const rows = (await (
        await SELF.fetch('http://api.local/api/folios?overdue=true', { headers: auth(ADMIN) })
      ).json()) as any
      const counts = (await (
        await SELF.fetch('http://api.local/api/folios/counts', { headers: auth(ADMIN) })
      ).json()) as any
      return { facet: rows.folios.map((f: any) => f.id), count: counts.overdue }
    }

    // Inside the owing line's hold: nobody calls it overdue, and the clock shown is ITS clock.
    const row = await sellerRow()
    expect(row.overdue).toBe(false)
    expect(row.booking_expires_at).toBe(Number((await line(far.id)).booking_expires_at))
    expect(await adminView()).toEqual({ facet: [], count: 0 })

    // Once the owing line's own clock passes, all three say so together.
    await env.DB.prepare(`UPDATE folio_lines SET booking_expires_at = ? WHERE id = ?`)
      .bind(nowSec() - 60, far.id)
      .run()
    expect((await sellerRow()).overdue).toBe(true)
    expect(await adminView()).toEqual({ facet: [folio.id], count: 1 })
  })

  it('a paid line is refused for being paid, never for a hold it no longer has', async () => {
    const stage = await seedStage()
    const { folio, near } = await mixedApartado(stage, 'future')

    const res = await post(stage.agent, `/folios/${folio.id}/lines/${near.id}/settle`)

    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('LINE_ALREADY_PAID')
  })

  it('rescheduling the owing line writes no fresh clock onto the paid one', async () => {
    const stage = await seedStage()
    const { folio, near, far } = await mixedApartado(stage, 'future')
    const nearBefore = (await line(near.id)).booking_expires_at
    const farBefore = (await line(far.id)).booking_expires_at
    const later = await seedSlot(stage.organizationId, stage.serviceId, addDays(todayStr(), 12))

    const res = await post(stage.agent, `/folios/${folio.id}/reschedule`, {
      moves: [{ folio_line_id: far.id, to_slot_id: later }],
    })

    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect((await line(near.id)).booking_expires_at).toBe(nearBefore)
    // The owing line moved two days later, so its own clock did recompute.
    expect((await line(far.id)).booking_expires_at).not.toBe(farBefore)
  })
})

describe('bug: settled-line-clock-expiry — multitenancy', () => {
  it('each org\'s sweep writes stay on its own folio, and neither paid line is cancelled', async () => {
    const a = await seedStage('agent-a@empresa.com')
    const b = await seedStage('agent-b@empresa.com')
    expect(a.organizationId).not.toBe(b.organizationId)
    const fa = await mixedApartado(a, 'past')
    const fb = await mixedApartado(b, 'past')

    await sweepExpiredBookings(env)

    for (const [stage, f] of [
      [a, fa],
      [b, fb],
    ] as const) {
      expect((await line(f.near.id)).cancelled_at).toBeNull()
      const events = await outbox(f.folio.id)
      expect(events.filter((e) => e.event === 'booking_grace_entered')).toHaveLength(1)
      expect(events.every((e) => e.organization_id === stage.organizationId)).toBe(true)
    }
  })
})
