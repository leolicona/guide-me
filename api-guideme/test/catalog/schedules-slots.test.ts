import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Schedules & Slots (US-A10) — specific-date slots + recurring weekly schedules
// that materialize concrete slot rows, nested under a service.
// Spec: docs/schedules/schedules-slots.spec.md (Scenarios 1–20).
// Multitenancy isolation (18–20) uses the shared `seedTwoOrgs` helper, per
// docs/multitenancy/multitenancy.spec.md (B4, B3, B1) and CLAUDE.md.
//
// Calendar reference: 2026-06-08 is a Monday, so in [2026-06-08, 2026-06-21]
// the Mon/Wed/Fri dates are 08,10,12,15,17,19 → 6 slots.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

// --- Local seeders (raw D1) ------------------------------------------------

interface SeedServiceOptions {
  organizationId: string
  name?: string
  defaultCapacity?: number
  status?: 'active' | 'inactive'
}

const seedService = async ({
  organizationId,
  name = 'City Tour',
  defaultCapacity = 12,
  status = 'active',
}: SeedServiceOptions): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 150000, 100000, ?, ?, ?, ?)`,
  )
    .bind(serviceId, organizationId, name, defaultCapacity, status, ts, ts)
    .run()
  return { serviceId }
}

interface SeedSlotOptions {
  organizationId: string
  serviceId: string
  scheduleId?: string | null
  date?: string
  startTime?: string
  capacity?: number
  booked?: number
  status?: 'active' | 'inactive'
  /** Override updated_at (unix seconds) — used to assert it advances on edit. */
  updatedAt?: number
}

const seedSlot = async ({
  organizationId,
  serviceId,
  scheduleId = null,
  date = '2026-06-15',
  startTime = '06:00',
  capacity = 12,
  booked = 0,
  status = 'active',
  updatedAt,
}: SeedSlotOptions): Promise<{ slotId: string }> => {
  const slotId = crypto.randomUUID()
  const ts = updatedAt ?? Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      slotId,
      organizationId,
      serviceId,
      scheduleId,
      date,
      startTime,
      capacity,
      booked,
      status,
      ts,
      ts,
    )
    .run()
  return { slotId }
}

interface SeedScheduleOptions {
  organizationId: string
  serviceId: string
  weekdays?: string
  startTime?: string
  capacity?: number
  startDate?: string
  endDate?: string
  status?: 'active' | 'inactive'
}

const seedSchedule = async ({
  organizationId,
  serviceId,
  weekdays = '1,3,5',
  startTime = '06:00',
  capacity = 12,
  startDate = '2026-06-08',
  endDate = '2026-06-21',
  status = 'active',
}: SeedScheduleOptions): Promise<{ scheduleId: string }> => {
  const scheduleId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO schedules
       (id, organization_id, service_id, recurrence, weekdays, start_time, capacity, start_date, end_date, status)
     VALUES (?, ?, ?, 'weekly', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      scheduleId,
      organizationId,
      serviceId,
      weekdays,
      startTime,
      capacity,
      startDate,
      endDate,
      status,
    )
    .run()
  return { scheduleId }
}

// --- After-state readers ---------------------------------------------------

const getSlotRow = (id: string) =>
  env.DB.prepare(
    `SELECT id, organization_id, service_id, schedule_id, date, start_time,
            capacity, booked, status, updated_at
       FROM slots WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string
      organization_id: string
      service_id: string
      schedule_id: string | null
      date: string
      start_time: string
      capacity: number
      booked: number
      status: string
      updated_at: number
    }>()

const getScheduleRow = (id: string) =>
  env.DB.prepare(
    `SELECT id, organization_id, service_id, weekdays, start_time, capacity,
            start_date, end_date, status FROM schedules WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string
      organization_id: string
      service_id: string
      weekdays: string
      start_time: string
      capacity: number
      start_date: string
      end_date: string
      status: string
    }>()

const countSlots = async () => {
  const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM slots').first<{
    c: number
  }>()
  return r?.c ?? 0
}
const countSchedules = async () => {
  const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM schedules').first<{
    c: number
  }>()
  return r?.c ?? 0
}

// slots → schedules → services → organizations; clear children first.
const clearScheduleDb = async () => {
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearScheduleDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

const base = 'http://api.local/api/services'

// ---------------------------------------------------------------------------
// US-A10 — Specific-date slots
// ---------------------------------------------------------------------------
describe('US-A10 — specific-date slots', () => {
  it('Scenario 1 — creates an active one-off slot with remaining', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })

    const res = await SELF.fetch(`${base}/${serviceId}/slots`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        date: '2026-06-15',
        start_time: '06:00',
        capacity: 12,
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { slot: any }
    expect(body.slot).toMatchObject({
      service_id: serviceId,
      schedule_id: null,
      date: '2026-06-15',
      start_time: '06:00',
      capacity: 12,
      booked: 0,
      remaining: 12,
      status: 'active',
    })

    const row = await getSlotRow(body.slot.id)
    expect(row).toMatchObject({
      organization_id: organizationId,
      schedule_id: null,
      booked: 0,
      status: 'active',
    })
  })

  it('Scenario 2 — capacity omitted defaults to service.default_capacity', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId, defaultCapacity: 10 })

    const res = await SELF.fetch(`${base}/${serviceId}/slots`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ date: '2026-06-15', start_time: '06:00' }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { slot: any }
    expect(body.slot.capacity).toBe(10)
    expect(body.slot.remaining).toBe(10)
  })

  it('Scenario 3 — invalid date / time / capacity → 400, no row', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })

    const bad = [
      { date: '06-15-2026', start_time: '06:00' }, // wrong date format
      { date: '2026-06-15', start_time: '6:00' }, // wrong time format
      { date: '2026-06-15', start_time: '25:00' }, // hour out of range
      { date: '2026-06-15', start_time: '06:00', capacity: 0 }, // capacity 0
      { date: '2026-06-15', start_time: '06:00', capacity: -3 }, // negative
      { date: '2026-06-15', start_time: '06:00', capacity: 1.5 }, // non-integer
    ]

    for (const payload of bad) {
      const res = await SELF.fetch(`${base}/${serviceId}/slots`, {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify(payload),
      })
      expect(res.status, JSON.stringify(payload)).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    }

    expect(await countSlots()).toBe(0)
  })

  it('Scenario 4 — duplicate active slot → 409, only original exists', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: '2026-06-15', startTime: '06:00' })

    const res = await SELF.fetch(`${base}/${serviceId}/slots`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ date: '2026-06-15', start_time: '06:00' }),
    })

    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('CONFLICT')
    expect(await countSlots()).toBe(1)
  })

  it('Scenario 5 — list active-only, ordered by date+time; from/to/status filters', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: '2026-06-17', startTime: '06:00' })
    await seedSlot({ organizationId, serviceId, date: '2026-06-15', startTime: '09:00' })
    await seedSlot({ organizationId, serviceId, date: '2026-06-15', startTime: '06:00' })
    await seedSlot({
      organizationId,
      serviceId,
      date: '2026-06-20',
      startTime: '06:00',
      status: 'inactive',
    })

    // default: active only, ordered by (date, start_time)
    const r1 = await SELF.fetch(`${base}/${serviceId}/slots`, {
      headers: auth(ADMIN_EMAIL),
    })
    const b1 = (await r1.json()) as { slots: any[] }
    expect(b1.slots.map((s) => [s.date, s.start_time])).toEqual([
      ['2026-06-15', '06:00'],
      ['2026-06-15', '09:00'],
      ['2026-06-17', '06:00'],
    ])

    // date range
    const r2 = await SELF.fetch(
      `${base}/${serviceId}/slots?from=2026-06-16&to=2026-06-18`,
      { headers: auth(ADMIN_EMAIL) },
    )
    const b2 = (await r2.json()) as { slots: any[] }
    expect(b2.slots.map((s) => s.date)).toEqual(['2026-06-17'])

    // status=all includes the inactive slot
    const r3 = await SELF.fetch(`${base}/${serviceId}/slots?status=all`, {
      headers: auth(ADMIN_EMAIL),
    })
    const b3 = (await r3.json()) as { slots: any[] }
    expect(b3.slots).toHaveLength(4)
  })

  it('Scenario 6 — edit changes time/capacity, advances updated_at, keeps invariants', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })
    const past = Math.floor(Date.now() / 1000) - 1000
    const { slotId } = await seedSlot({
      organizationId,
      serviceId,
      date: '2026-06-15',
      startTime: '06:00',
      capacity: 12,
      updatedAt: past,
    })

    const res = await SELF.fetch(`${base}/${serviceId}/slots/${slotId}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        date: '2026-06-15',
        start_time: '07:30',
        capacity: 20,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { slot: any }
    expect(body.slot).toMatchObject({ start_time: '07:30', capacity: 20 })

    const row = await getSlotRow(slotId)
    expect(row).toMatchObject({
      organization_id: organizationId,
      service_id: serviceId,
      status: 'active',
      booked: 0,
      start_time: '07:30',
      capacity: 20,
    })
    expect(row!.updated_at).toBeGreaterThan(past)
  })

  it('Scenario 7 — edit into a colliding time → 409, both unchanged', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })
    const a = await seedSlot({ organizationId, serviceId, date: '2026-06-15', startTime: '06:00' })
    const b = await seedSlot({ organizationId, serviceId, date: '2026-06-15', startTime: '07:00' })

    const res = await SELF.fetch(`${base}/${serviceId}/slots/${a.slotId}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        date: '2026-06-15',
        start_time: '07:00',
        capacity: 12,
      }),
    })

    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('CONFLICT')
    expect((await getSlotRow(a.slotId))!.start_time).toBe('06:00')
    expect((await getSlotRow(b.slotId))!.start_time).toBe('07:00')
  })

  it('Scenario 8 — deactivate (x2) idempotent, reactivate; never deleted', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })
    const { slotId } = await seedSlot({ organizationId, serviceId })

    const d1 = await SELF.fetch(`${base}/${serviceId}/slots/${slotId}/deactivate`, {
      method: 'POST',
      headers: auth(ADMIN_EMAIL),
    })
    expect(d1.status).toBe(200)
    expect((await getSlotRow(slotId))!.status).toBe('inactive')

    const d2 = await SELF.fetch(`${base}/${serviceId}/slots/${slotId}/deactivate`, {
      method: 'POST',
      headers: auth(ADMIN_EMAIL),
    })
    expect(d2.status).toBe(200)
    expect((await getSlotRow(slotId))!.status).toBe('inactive')

    const r = await SELF.fetch(`${base}/${serviceId}/slots/${slotId}/reactivate`, {
      method: 'POST',
      headers: auth(ADMIN_EMAIL),
    })
    expect(r.status).toBe(200)
    expect((await getSlotRow(slotId))!.status).toBe('active')
    expect(await countSlots()).toBe(1)
  })

  it('Scenario 9 — reactivate into a taken time → 409', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })
    const inactive = await seedSlot({
      organizationId,
      serviceId,
      date: '2026-06-15',
      startTime: '06:00',
      status: 'inactive',
    })
    await seedSlot({
      organizationId,
      serviceId,
      date: '2026-06-15',
      startTime: '06:00',
      status: 'active',
    })

    const res = await SELF.fetch(
      `${base}/${serviceId}/slots/${inactive.slotId}/reactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('CONFLICT')
    expect((await getSlotRow(inactive.slotId))!.status).toBe('inactive')
  })
})

// ---------------------------------------------------------------------------
// US-A10 — Recurring schedules
// ---------------------------------------------------------------------------
describe('US-A10 — recurring schedules', () => {
  it('Scenario 10 — weekly schedule materializes Mon/Wed/Fri, default capacity', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId, defaultCapacity: 12 })

    const res = await SELF.fetch(`${base}/${serviceId}/schedules`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        weekdays: [1, 3, 5],
        start_time: '06:00',
        start_date: '2026-06-08',
        end_date: '2026-06-21',
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { schedule: any; slots_generated: number }
    expect(body.slots_generated).toBe(6)
    expect(body.schedule).toMatchObject({
      service_id: serviceId,
      recurrence: 'weekly',
      weekdays: [1, 3, 5],
      capacity: 12,
      status: 'active',
    })

    // every generated slot links the schedule, capacity 12, booked 0, active
    const rows = await env.DB.prepare(
      `SELECT date, capacity, booked, status, schedule_id FROM slots
        WHERE service_id = ? ORDER BY date`,
    )
      .bind(serviceId)
      .all<{ date: string; capacity: number; booked: number; status: string; schedule_id: string }>()
    expect(rows.results.map((r) => r.date)).toEqual([
      '2026-06-08',
      '2026-06-10',
      '2026-06-12',
      '2026-06-15',
      '2026-06-17',
      '2026-06-19',
    ])
    expect(rows.results.every((r) => r.capacity === 12 && r.booked === 0 && r.status === 'active')).toBe(true)
    expect(rows.results.every((r) => r.schedule_id === body.schedule.id)).toBe(true)
  })

  it('Scenario 11 — materialization skips already-occupied times', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId, defaultCapacity: 8 })
    // pre-occupy Wed 2026-06-10 06:00 with a one-off slot
    const occupied = await seedSlot({
      organizationId,
      serviceId,
      date: '2026-06-10',
      startTime: '06:00',
      capacity: 99,
    })

    const res = await SELF.fetch(`${base}/${serviceId}/schedules`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        weekdays: [1, 3, 5],
        start_time: '06:00',
        start_date: '2026-06-08',
        end_date: '2026-06-21',
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { slots_generated: number }
    expect(body.slots_generated).toBe(5) // 6 candidates - 1 occupied

    // pre-existing slot untouched (capacity still 99, no schedule_id)
    const row = await getSlotRow(occupied.slotId)
    expect(row).toMatchObject({ capacity: 99, schedule_id: null })
    expect(await countSlots()).toBe(6) // 1 pre-existing + 5 generated
  })

  it('Scenario 12 — end_date < start_date or horizon > 366 → 400, nothing written', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })

    const bad = [
      { start_date: '2026-06-08', end_date: '2026-06-01' }, // end < start
      { start_date: '2026-01-01', end_date: '2027-12-31' }, // > 366 days
    ]
    for (const win of bad) {
      const res = await SELF.fetch(`${base}/${serviceId}/schedules`, {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({ weekdays: [1], start_time: '06:00', ...win }),
      })
      expect(res.status, JSON.stringify(win)).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    }

    expect(await countSchedules()).toBe(0)
    expect(await countSlots()).toBe(0)
  })

  it('Scenario 13 — empty / out-of-range weekdays → 400', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })

    const bad = [
      { weekdays: [] },
      { weekdays: [7] },
      { weekdays: [-1] },
    ]
    for (const w of bad) {
      const res = await SELF.fetch(`${base}/${serviceId}/schedules`, {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({
          start_time: '06:00',
          start_date: '2026-06-08',
          end_date: '2026-06-21',
          ...w,
        }),
      })
      expect(res.status, JSON.stringify(w)).toBe(400)
    }
    expect(await countSchedules()).toBe(0)
  })

  it('Scenario 14 — list schedules ordered by start_date; weekdays as int[]', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })
    await seedSchedule({ organizationId, serviceId, startDate: '2026-07-01', endDate: '2026-07-31' })
    await seedSchedule({ organizationId, serviceId, weekdays: '2,4', startDate: '2026-06-01', endDate: '2026-06-30' })

    const res = await SELF.fetch(`${base}/${serviceId}/schedules`, {
      headers: auth(ADMIN_EMAIL),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schedules: any[] }
    expect(body.schedules.map((s) => s.start_date)).toEqual([
      '2026-06-01',
      '2026-07-01',
    ])
    expect(body.schedules[0].weekdays).toEqual([2, 4])
  })

  it('Scenario 15 — deactivate schedule cascades to unbooked slots only', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId, defaultCapacity: 5 })

    const created = (await (
      await SELF.fetch(`${base}/${serviceId}/schedules`, {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({
          weekdays: [1, 3, 5],
          start_time: '06:00',
          start_date: '2026-06-08',
          end_date: '2026-06-21',
        }),
      })
    ).json()) as { schedule: any }
    const scheduleId = created.schedule.id

    // book one generated slot
    const oneSlot = await env.DB.prepare(
      `SELECT id FROM slots WHERE schedule_id = ? LIMIT 1`,
    )
      .bind(scheduleId)
      .first<{ id: string }>()
    await env.DB.prepare(`UPDATE slots SET booked = 2 WHERE id = ?`)
      .bind(oneSlot!.id)
      .run()

    const res = await SELF.fetch(
      `${base}/${serviceId}/schedules/${scheduleId}/deactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schedule: any; slots_closed: number }
    expect(body.schedule.status).toBe('inactive')
    expect(body.slots_closed).toBe(5) // 6 generated − 1 booked

    expect((await getScheduleRow(scheduleId))!.status).toBe('inactive')
    // booked slot stays active
    expect((await getSlotRow(oneSlot!.id))!.status).toBe('active')
    const active = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM slots WHERE schedule_id = ? AND status = 'active'`,
    )
      .bind(scheduleId)
      .first<{ c: number }>()
    expect(active!.c).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// US-A10 — Authorization & parent guard
// ---------------------------------------------------------------------------
describe('US-A10 — auth & parent guard', () => {
  it('Scenario 16 — agent role → 403 on slots/schedules routes', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId } = await seedService({ organizationId })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })

    const calls = [
      SELF.fetch(`${base}/${serviceId}/slots`, { headers: auth(AGENT_EMAIL) }),
      SELF.fetch(`${base}/${serviceId}/slots`, {
        method: 'POST',
        headers: jsonAuth(AGENT_EMAIL),
        body: JSON.stringify({ date: '2026-06-15', start_time: '06:00' }),
      }),
      SELF.fetch(`${base}/${serviceId}/schedules`, { headers: auth(AGENT_EMAIL) }),
    ]
    for (const p of calls) {
      const res = await p
      expect(res.status).toBe(403)
      expect(((await res.json()) as any).error.code).toBe('FORBIDDEN')
    }
  })

  it('Scenario 17 — unknown / foreign parent service → 404', async () => {
    await seedUser({ email: ADMIN_EMAIL })
    const ghost = crypto.randomUUID()

    const calls = [
      SELF.fetch(`${base}/${ghost}/slots`, { headers: auth(ADMIN_EMAIL) }),
      SELF.fetch(`${base}/${ghost}/slots`, {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({ date: '2026-06-15', start_time: '06:00' }),
      }),
      SELF.fetch(`${base}/${ghost}/schedules`, { headers: auth(ADMIN_EMAIL) }),
      SELF.fetch(`${base}/${ghost}/schedules`, {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({
          weekdays: [1],
          start_time: '06:00',
          start_date: '2026-06-08',
          end_date: '2026-06-21',
        }),
      }),
    ]
    for (const p of calls) {
      const res = await p
      expect(res.status).toBe(404)
      expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
    }
    expect(await countSlots()).toBe(0)
    expect(await countSchedules()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation (B4 / B3 / B1)
// ---------------------------------------------------------------------------
describe('US-A10 — multitenancy isolation', () => {
  it('Scenario 18 — B4: slot/schedule lists are scoped to the caller org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const a = await seedService({ organizationId: orgA.organizationId, name: 'A tour' })
    const b = await seedService({ organizationId: orgB.organizationId, name: 'B tour' })
    await seedSlot({ organizationId: orgA.organizationId, serviceId: a.serviceId, date: '2026-06-15' })
    await seedSlot({ organizationId: orgB.organizationId, serviceId: b.serviceId, date: '2026-06-15' })
    await seedSchedule({ organizationId: orgA.organizationId, serviceId: a.serviceId })
    await seedSchedule({ organizationId: orgB.organizationId, serviceId: b.serviceId })

    const slotsRes = await SELF.fetch(`${base}/${a.serviceId}/slots`, {
      headers: auth(orgA.adminEmail),
    })
    const slotsBody = (await slotsRes.json()) as { slots: any[] }
    expect(slotsBody.slots).toHaveLength(1)
    expect(slotsBody.slots.every((s) => s.service_id === a.serviceId)).toBe(true)

    const schedRes = await SELF.fetch(`${base}/${a.serviceId}/schedules`, {
      headers: auth(orgA.adminEmail),
    })
    const schedBody = (await schedRes.json()) as { schedules: any[] }
    expect(schedBody.schedules).toHaveLength(1)
    expect(schedBody.schedules.every((s) => s.service_id === a.serviceId)).toBe(true)
  })

  it('Scenario 19 — B3: cross-org slot/schedule ops → 404, targets untouched', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const b = await seedService({ organizationId: orgB.organizationId })
    const slotB = await seedSlot({
      organizationId: orgB.organizationId,
      serviceId: b.serviceId,
      date: '2026-06-15',
      startTime: '06:00',
    })
    const schedB = await seedSchedule({
      organizationId: orgB.organizationId,
      serviceId: b.serviceId,
    })

    // org A admin targets org B's service / slot / schedule
    const calls = [
      SELF.fetch(`${base}/${b.serviceId}/slots`, { headers: auth(orgA.adminEmail) }),
      SELF.fetch(`${base}/${b.serviceId}/slots/${slotB.slotId}`, {
        method: 'PUT',
        headers: jsonAuth(orgA.adminEmail),
        body: JSON.stringify({ date: '2026-06-15', start_time: '08:00', capacity: 3 }),
      }),
      SELF.fetch(`${base}/${b.serviceId}/slots/${slotB.slotId}/deactivate`, {
        method: 'POST',
        headers: auth(orgA.adminEmail),
      }),
      SELF.fetch(`${base}/${b.serviceId}/schedules/${schedB.scheduleId}/deactivate`, {
        method: 'POST',
        headers: auth(orgA.adminEmail),
      }),
    ]
    for (const p of calls) {
      const res = await p
      expect(res.status).toBe(404)
      expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
    }

    // org B's rows are unchanged
    expect(await getSlotRow(slotB.slotId)).toMatchObject({
      start_time: '06:00',
      status: 'active',
    })
    expect((await getScheduleRow(schedB.scheduleId))!.status).toBe('active')
  })

  it('Scenario 20 — B1: injected organizationId / booked / status ignored', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const a = await seedService({ organizationId: orgA.organizationId })

    // slot create with injected fields
    const slotRes = await SELF.fetch(`${base}/${a.serviceId}/slots`, {
      method: 'POST',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        date: '2026-06-15',
        start_time: '06:00',
        capacity: 12,
        organizationId: orgB.organizationId,
        booked: 99,
        status: 'inactive',
      }),
    })
    expect(slotRes.status).toBe(201)
    const slotBody = (await slotRes.json()) as { slot: any }
    const slotRow = await getSlotRow(slotBody.slot.id)
    expect(slotRow).toMatchObject({
      organization_id: orgA.organizationId,
      booked: 0,
      status: 'active',
    })

    // schedule create with injected fields
    const schedRes = await SELF.fetch(`${base}/${a.serviceId}/schedules`, {
      method: 'POST',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        weekdays: [1],
        start_time: '06:00',
        start_date: '2026-06-08',
        end_date: '2026-06-21',
        organizationId: orgB.organizationId,
        status: 'inactive',
      }),
    })
    expect(schedRes.status).toBe(201)
    const schedBody = (await schedRes.json()) as { schedule: any }
    const schedRow = await getScheduleRow(schedBody.schedule.id)
    expect(schedRow).toMatchObject({
      organization_id: orgA.organizationId,
      status: 'active',
    })
  })
})
