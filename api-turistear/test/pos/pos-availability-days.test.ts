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
  // US-AG57 S9 seeds an affiliate allow-list; its FK to `services` blocks the delete below.
  await env.DB.exec('DELETE FROM affiliate_commissions')
  await env.DB.exec('DELETE FROM services')
  // `users.affiliate_company_id` holds the company too, and clearTenancyDb drops users and
  // organizations together — so release the link here rather than interleave with it.
  await env.DB.exec('UPDATE users SET affiliate_company_id = NULL')
  await env.DB.exec('DELETE FROM affiliate_companies')
  await clearTenancyDb()
})
afterEach(async () => {
  await env.DB.exec('DELETE FROM slots')
  // US-AG57 S9 seeds an affiliate allow-list; its FK to `services` blocks the delete below.
  await env.DB.exec('DELETE FROM affiliate_commissions')
  await env.DB.exec('DELETE FROM services')
  // `users.affiliate_company_id` holds the company too, and clearTenancyDb drops users and
  // organizations together — so release the link here rather than interleave with it.
  await env.DB.exec('UPDATE users SET affiliate_company_id = NULL')
  await env.DB.exec('DELETE FROM affiliate_companies')
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

// ---------------------------------------------------------------------------
// US-AG57 — the SERVICE-SCOPED month: three day states for the sale sheet's calendar
// Spec: docs/pos/service-sheet-calendar.spec.md (S1–S9).
//
// The tests above are left UNEDITED: they are the scope boundary stated as a mechanical test —
// the org-wide, category-scoped behaviour must be byte-identical when `service_id` is absent.
// ---------------------------------------------------------------------------
const listServiceDays = async (email: string, query: string) => {
  const res = await SELF.fetch(`${POS}/availability/days${query}`, { headers: auth(email) })
  const body = (await res.json()) as { days?: string[]; sold_out?: string[] }
  return { status: res.status, days: body.days, soldOut: body.sold_out }
}

const D1 = '2026-06-16'
const D2 = '2026-06-17'
const MONTH = '?month=2026-06&today=2026-06-15'

describe('US-AG57 — service-scoped month classifies days three ways', () => {
  it('S1 — a day with room for the party is available', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: D1, capacity: 12, booked: 8 }) // 4 free

    const { days, soldOut } = await listServiceDays(
      AGENT_EMAIL,
      `${MONTH}&service_id=${serviceId}&party=4`,
    )
    expect(days).toContain(D1)
    expect(soldOut).not.toContain(D1)
  })

  it('S2 — a day that operates but cannot take the party is SOLD OUT, not absent', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: D1, capacity: 12, booked: 10 }) // 2 free

    const { days, soldOut } = await listServiceDays(
      AGENT_EMAIL,
      `${MONTH}&service_id=${serviceId}&party=4`,
    )
    // US-AG33's distinction: the service RUNS that day, so it must never read as non-operating.
    expect(soldOut).toContain(D1)
    expect(days).not.toContain(D1)
  })

  it('S3 — a day the service does not run appears in neither array', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: D1, capacity: 12, booked: 0 })

    const { days, soldOut } = await listServiceDays(
      AGENT_EMAIL,
      `${MONTH}&service_id=${serviceId}&party=1`,
    )
    // D2 has no slot at all — absent from BOTH is what the client paints as non-operating.
    expect(days).not.toContain(D2)
    expect(soldOut).not.toContain(D2)
  })

  it('S4 — party re-classifies a day, it does not filter the month away', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: D1, capacity: 12, booked: 9 }) // 3 free

    const fits = await listServiceDays(AGENT_EMAIL, `${MONTH}&service_id=${serviceId}&party=3`)
    expect(fits.days).toContain(D1)
    const tooBig = await listServiceDays(AGENT_EMAIL, `${MONTH}&service_id=${serviceId}&party=4`)
    // The day does not vanish — it moves. The grid must still show that the service runs.
    expect(tooBig.days).not.toContain(D1)
    expect(tooBig.soldOut).toContain(D1)
  })

  it('S5 — the Soft Cap margin counts toward the party', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, isFlexible: true, flexCapacityPct: 20 })
    // Full on raw capacity; floor(10 × 20 / 100) = 2 sellable margin seats (US-A36).
    await seedSlot({ organizationId, serviceId, date: D1, capacity: 10, booked: 10 })

    const two = await listServiceDays(AGENT_EMAIL, `${MONTH}&service_id=${serviceId}&party=2`)
    expect(two.days).toContain(D1)
    const three = await listServiceDays(AGENT_EMAIL, `${MONTH}&service_id=${serviceId}&party=3`)
    expect(three.soldOut).toContain(D1)
  })

  it('S6 — a departure past the sales cutoff cannot make a day available', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    const CLOCK_DAY = '2026-06-14' // the frozen "now" day; threshold is 12:00
    await seedSlot({ organizationId, serviceId, date: CLOCK_DAY, startTime: '10:00', capacity: 12, booked: 0 })
    await seedSlot({ organizationId, serviceId, date: CLOCK_DAY, startTime: '18:00', capacity: 12, booked: 12 })

    const { days, soldOut } = await listServiceDays(
      AGENT_EMAIL,
      `?month=2026-06&today=${CLOCK_DAY}&service_id=${serviceId}&party=1`,
    )
    // The roomy 10:00 has left; the 18:00 is sellable but full. D13: the day still OPERATES,
    // so it reads Agotado rather than disappearing as if the service did not run.
    expect(soldOut).toContain(CLOCK_DAY)
    expect(days).not.toContain(CLOCK_DAY)
  })

  it('S7 — without service_id the response is unchanged (no sold_out key)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: D1 })

    const res = await SELF.fetch(`${POS}/availability/days${MONTH}`, { headers: auth(AGENT_EMAIL) })
    const body = (await res.json()) as Record<string, unknown>
    expect(body.days).toContain(D1)
    // The scope boundary, asserted: today's consumers see a byte-identical shape.
    expect(body).not.toHaveProperty('sold_out')
  })

  it('S8 — B4: a foreign service_id returns an empty month, never org B calendar', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: orgA.organizationId })
    const b = await seedService({ organizationId: orgB.organizationId, name: 'B Tour' })
    await seedSlot({ organizationId: orgB.organizationId, serviceId: b.serviceId, date: D1 })
    await seedSlot({ organizationId: orgB.organizationId, serviceId: b.serviceId, date: D2 })

    const { days, soldOut } = await listServiceDays(
      AGENT_EMAIL,
      `${MONTH}&service_id=${b.serviceId}&party=1`,
    )
    expect(days).toEqual([])
    expect(soldOut).toEqual([])
  })

  it('S9 — an affiliate may not probe a non-curated service', async () => {
    const { organizationId } = await seedUser({ email: 'admin@empresa.com', role: 'admin' })
    const ts = Math.floor(Date.now() / 1000)
    const companyId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO affiliate_companies (id, organization_id, name, contact_email, contact_phone, status, created_at, updated_at)
       VALUES (?, ?, 'Hotel Aliado', NULL, NULL, 'active', ?, ?)`,
    ).bind(companyId, organizationId, ts, ts).run()
    await seedUser({
      email: 'aliado@hotel.com',
      role: 'affiliate',
      organizationId,
      affiliateCompanyId: companyId,
    })

    // Two services in the org; only the first is on the affiliate's allow-list.
    const curated = await seedService({ organizationId, name: 'Curated Tour' })
    const hidden = await seedService({ organizationId, name: 'Hidden Tour' })
    await env.DB.prepare(
      `INSERT INTO affiliate_commissions (id, organization_id, affiliate_company_id, service_id, commission_type, commission_value, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'percent', 10, ?, ?)`,
    ).bind(crypto.randomUUID(), organizationId, companyId, curated.serviceId, ts, ts).run()
    await seedSlot({ organizationId, serviceId: curated.serviceId, date: D1 })
    await seedSlot({ organizationId, serviceId: hidden.serviceId, date: D1 })

    const own = await listServiceDays(
      'aliado@hotel.com',
      `${MONTH}&service_id=${curated.serviceId}&party=1`,
    )
    expect(own.days).toContain(D1)

    const probe = await listServiceDays(
      'aliado@hotel.com',
      `${MONTH}&service_id=${hidden.serviceId}&party=1`,
    )
    // An EMPTY month, not a 404: the calendar is a paint, and an error would confirm the
    // service exists. Mirrors getPosService's defence-in-depth without leaking existence.
    expect(probe.status).toBe(200)
    expect(probe.days).toEqual([])
    expect(probe.soldOut).toEqual([])
  })
})
