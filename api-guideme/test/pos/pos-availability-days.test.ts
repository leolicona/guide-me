import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// POS Date Filter — month availability for the calendar Bottom Sheet (US-AG35).
// Spec: docs/pos/date-filter-calendar-sheet.spec.md (Scenarios 5, 10).
//
// GET /api/pos/availability/days?month=YYYY-MM&today=YYYY-MM-DD returns the org-scoped
// set of dates IN THAT MONTH with ≥ 1 active slot whose effective remaining > 0 (US-A36).
// The server derives the [firstOfMonth, lastOfMonth] window itself; past days never
// surface (the current month floors at `today`); a fully-past month returns []. The
// `today` param keeps the seeded calendar deterministic regardless of the wall clock.

const AGENT_EMAIL = 'agent@empresa.com'
const POS = 'http://api.local/api/pos'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })

const TODAY = '2026-06-15'

// --- Local seeders (raw D1) ------------------------------------------------

interface SeedServiceOptions {
  organizationId: string
  name?: string
  isFlexible?: boolean
  flexCapacityPct?: number
  status?: 'active' | 'inactive'
  category?: 'lodging' | 'tours' | 'dining' | 'adventure' | 'culture'
}

const seedService = async ({
  organizationId,
  name = 'City Tour',
  isFlexible = false,
  flexCapacityPct = 0,
  status = 'active',
  category = 'tours',
}: SeedServiceOptions): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        commission_type, commission_value, is_flexible, flex_capacity_pct, category, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 150000, 100000, 12, 'percent', 0, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(serviceId, organizationId, name, isFlexible ? 1 : 0, flexCapacityPct, category, status, ts, ts)
    .run()
  return { serviceId }
}

interface SeedSlotOptions {
  organizationId: string
  serviceId: string
  date?: string
  startTime?: string
  capacity?: number
  booked?: number
  status?: 'active' | 'inactive'
}

const seedSlot = async ({
  organizationId,
  serviceId,
  date = TODAY,
  startTime = '06:00',
  capacity = 12,
  booked = 0,
  status = 'active',
}: SeedSlotOptions): Promise<{ slotId: string }> => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, date, startTime, capacity, booked, status, ts, ts)
    .run()
  return { slotId }
}

const listDays = async (email: string, query = '') => {
  const res = await SELF.fetch(`${POS}/availability/days${query}`, { headers: auth(email) })
  const body = (await res.json()) as { days?: string[] }
  return { status: res.status, days: body.days }
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
  await clearTenancyDb()
})
afterEach(async () => {
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
  await clearTenancyDb()
})

// ---------------------------------------------------------------------------
// US-AG35 — month availability
// ---------------------------------------------------------------------------
describe('US-AG35 — POS month availability for the calendar sheet', () => {
  it('Scenario 5 — returns only the days with a sellable slot (sold-out days excluded, deduped)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    // Two sellable slots on 06-19 (same day → one entry), one available 06-27,
    // and a fully sold-out Hard Cap day on 06-21 (excluded).
    await seedSlot({ organizationId, serviceId, date: '2026-06-19', startTime: '08:00' })
    await seedSlot({ organizationId, serviceId, date: '2026-06-19', startTime: '14:00' })
    await seedSlot({ organizationId, serviceId, date: '2026-06-27' })
    await seedSlot({ organizationId, serviceId, date: '2026-06-21', capacity: 12, booked: 12 })

    const { status, days } = await listDays(AGENT_EMAIL, `?month=2026-06&today=${TODAY}`)
    expect(status).toBe(200)
    expect(days).toEqual(['2026-06-19', '2026-06-27'])
  })

  it('past days within the current month are never returned (window floors at today)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: '2026-06-10' }) // before today
    await seedSlot({ organizationId, serviceId, date: '2026-06-19' }) // after today

    const { days } = await listDays(AGENT_EMAIL, `?month=2026-06&today=${TODAY}`)
    expect(days).toEqual(['2026-06-19'])
  })

  it('Soft Cap flexible margin makes a fully-booked day available (US-A36)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, isFlexible: true, flexCapacityPct: 25 })
    // raw remaining 0, but floor(12×25/100)=3 effective spots remain.
    await seedSlot({ organizationId, serviceId, date: '2026-06-22', capacity: 12, booked: 12 })

    const { days } = await listDays(AGENT_EMAIL, `?month=2026-06&today=${TODAY}`)
    expect(days).toEqual(['2026-06-22'])
  })

  it('a fully-past month returns an empty set', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: '2026-05-20' })

    const { status, days } = await listDays(AGENT_EMAIL, `?month=2026-05&today=${TODAY}`)
    expect(status).toBe(200)
    expect(days).toEqual([])
  })

  it('a malformed month is rejected with 400', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    expect((await listDays(AGENT_EMAIL, `?month=2026-13&today=${TODAY}`)).status).toBe(400)
    expect((await listDays(AGENT_EMAIL, `?month=June&today=${TODAY}`)).status).toBe(400)
    expect((await listDays(AGENT_EMAIL, `?today=${TODAY}`)).status).toBe(400) // missing month
  })
})

// ---------------------------------------------------------------------------
// US-A37 — category-scoped availability dots
// ---------------------------------------------------------------------------
describe('US-A37 — category filter on the calendar dots', () => {
  it('scopes the days to a single selected category', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const tour = await seedService({ organizationId, name: 'Tour', category: 'tours' })
    const dining = await seedService({ organizationId, name: 'Cena', category: 'dining' })
    await seedSlot({ organizationId, serviceId: tour.serviceId, date: '2026-06-19' })
    await seedSlot({ organizationId, serviceId: dining.serviceId, date: '2026-06-20' })

    const { days } = await listDays(AGENT_EMAIL, `?month=2026-06&today=${TODAY}&categories=tours`)
    expect(days).toEqual(['2026-06-19']) // dining day excluded
  })

  it('returns the union of multiple selected categories', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const tour = await seedService({ organizationId, name: 'Tour', category: 'tours' })
    const dining = await seedService({ organizationId, name: 'Cena', category: 'dining' })
    const culture = await seedService({ organizationId, name: 'Museo', category: 'culture' })
    await seedSlot({ organizationId, serviceId: tour.serviceId, date: '2026-06-19' })
    await seedSlot({ organizationId, serviceId: dining.serviceId, date: '2026-06-20' })
    await seedSlot({ organizationId, serviceId: culture.serviceId, date: '2026-06-25' })

    const { days } = await listDays(
      AGENT_EMAIL,
      `?month=2026-06&today=${TODAY}&categories=tours,culture`,
    )
    expect(days).toEqual(['2026-06-19', '2026-06-25']) // dining excluded
  })

  it('an absent categories param means all categories (unchanged default)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const tour = await seedService({ organizationId, name: 'Tour', category: 'tours' })
    const dining = await seedService({ organizationId, name: 'Cena', category: 'dining' })
    await seedSlot({ organizationId, serviceId: tour.serviceId, date: '2026-06-19' })
    await seedSlot({ organizationId, serviceId: dining.serviceId, date: '2026-06-20' })

    const { days } = await listDays(AGENT_EMAIL, `?month=2026-06&today=${TODAY}`)
    expect(days).toEqual(['2026-06-19', '2026-06-20'])
  })

  it('unknown category keys are ignored, falling back to all categories', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const tour = await seedService({ organizationId, name: 'Tour', category: 'tours' })
    const dining = await seedService({ organizationId, name: 'Cena', category: 'dining' })
    await seedSlot({ organizationId, serviceId: tour.serviceId, date: '2026-06-19' })
    await seedSlot({ organizationId, serviceId: dining.serviceId, date: '2026-06-20' })

    const { status, days } = await listDays(
      AGENT_EMAIL,
      `?month=2026-06&today=${TODAY}&categories=bogus`,
    )
    expect(status).toBe(200)
    expect(days).toEqual(['2026-06-19', '2026-06-20']) // filtered to nothing → all
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation (required — Scenario 10, B4)
// ---------------------------------------------------------------------------
describe('US-AG35 — multitenancy isolation', () => {
  it('Scenario 10 — B4: month availability is scoped to the caller org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: orgA.organizationId })
    const a = await seedService({ organizationId: orgA.organizationId, name: 'A Tour' })
    await seedSlot({ organizationId: orgA.organizationId, serviceId: a.serviceId, date: '2026-06-19' })
    const b = await seedService({ organizationId: orgB.organizationId, name: 'B Dining' })
    await seedSlot({ organizationId: orgB.organizationId, serviceId: b.serviceId, date: '2026-06-20' })

    const { days } = await listDays(AGENT_EMAIL, `?month=2026-06&today=${TODAY}`)
    // org A's available day only; org B's slot can never light up a day for org A.
    expect(days).toEqual(['2026-06-19'])
  })
})
