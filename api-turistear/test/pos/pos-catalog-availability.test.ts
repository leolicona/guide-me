import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Default-Filtered POS Catalog & Lightweight Availability Query (US-AG30).
// Spec: docs/pos/default-filtered-catalog.spec.md (Scenarios 1–6, 11).
//
// The catalog read drops the Σ-remaining count for a windowed boolean
// `has_availability`, evaluated over a rolling 3-day window (today … today+2) by
// default or the single `date` the agent selected. Availability reads take an
// explicit `today` so the seeded calendar is deterministic regardless of the clock.
// Multitenancy isolation (Scenario 11, B4) uses the shared `seedTwoOrgs` helper.

const AGENT_EMAIL = 'agent@empresa.com'
const POS = 'http://api.local/api/pos'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })

// Deterministic calendar anchor. Default window = [TODAY, TODAY+2] = 06-15 … 06-17.
const TODAY = '2026-06-15'
const TOMORROW = '2026-06-16'
const PLUS_2 = '2026-06-17'
const PLUS_5 = '2026-06-20'

// --- Local seeders (raw D1) ------------------------------------------------

interface SeedServiceOptions {
  organizationId: string
  name?: string
  category?: 'lodging' | 'tours' | 'dining' | 'adventure' | 'culture' | null
  isFlexible?: boolean
  flexCapacityPct?: number
  status?: 'active' | 'inactive'
}

const seedService = async ({
  organizationId,
  name = 'City Tour',
  category = 'tours',
  isFlexible = false,
  flexCapacityPct = 0,
  status = 'active',
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

const listCatalog = async (email: string, query = '') => {
  const res = await SELF.fetch(`${POS}/services${query}`, { headers: auth(email) })
  const body = (await res.json()) as { services: any[] }
  return { status: res.status, services: body.services }
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
// US-AG30 — lightweight windowed availability
// ---------------------------------------------------------------------------
describe('US-AG30 — POS catalog lightweight windowed availability', () => {
  it('Scenario 1 — default window is the next 3 days; payload is lightweight', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, name: 'Canyon Tour' })
    await seedSlot({ organizationId, serviceId, date: PLUS_2, capacity: 12, booked: 2 })

    const { status, services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    expect(status).toBe(200)
    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({
      id: serviceId,
      name: 'Canyon Tour',
      has_availability: true,
      next_slot_date: PLUS_2,
    })
    // No spot count and no slot list cross the wire for the catalog read.
    expect(services[0]).not.toHaveProperty('available_spots')
    expect(services[0]).not.toHaveProperty('slots')
  })

  it('Scenario 2 — a slot beyond today+2 does not count as available', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: PLUS_5 })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    // Service is still listed (listing is not gated on availability), just unavailable.
    expect(services).toHaveLength(1)
    expect(services[0].has_availability).toBe(false)
  })

  it('Scenario 3 — a selected date collapses the window to that single day', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: TOMORROW })

    // date = today → the only slot (tomorrow) is outside the single-day window.
    const sameDay = await listCatalog(AGENT_EMAIL, `?today=${TODAY}&date=${TODAY}`)
    expect(sameDay.services[0].has_availability).toBe(false)

    // date = tomorrow → the slot is in the single-day window.
    const nextDay = await listCatalog(AGENT_EMAIL, `?today=${TODAY}&date=${TOMORROW}`)
    expect(nextDay.services[0].has_availability).toBe(true)
  })

  it('Scenario 4 — Soft Cap flexible margin counts as available', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({
      organizationId,
      isFlexible: true,
      flexCapacityPct: 25,
    })
    // raw remaining 0, but floor(12×25/100)=3 effective spots remain.
    await seedSlot({ organizationId, serviceId, date: TODAY, capacity: 12, booked: 12 })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    expect(services[0].has_availability).toBe(true)
  })

  it('Scenario 5 — a fully sold-out (effective) service reads unavailable', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId }) // Hard Cap, no margin
    await seedSlot({ organizationId, serviceId, date: TODAY, capacity: 12, booked: 12 })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    expect(services[0].has_availability).toBe(false)
  })

  it('Scenario 6 — a service with no in-window slot is unavailable and has no next_slot_date', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: PLUS_5 }) // out of window

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    expect(services[0]).toMatchObject({ id: serviceId, has_availability: false, next_slot_date: null })
  })
})

// ---------------------------------------------------------------------------
// US-AG35 — availability over the selected semantic date range (from/to)
// ---------------------------------------------------------------------------
describe('US-AG35 — catalog availability over a selected date range', () => {
  it('a from/to range widens the window beyond the default 3 days', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: PLUS_5 }) // 06-20, outside the default window

    // Default window [TODAY, TODAY+2] excludes it…
    const dflt = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    expect(dflt.services[0].has_availability).toBe(false)

    // …but a range covering 06-20 includes it (evaluated over the whole [from, to] span).
    const ranged = await listCatalog(
      AGENT_EMAIL,
      `?today=${TODAY}&from=2026-06-18&to=2026-06-22`,
    )
    expect(ranged.services[0].has_availability).toBe(true)
    expect(ranged.services[0].next_slot_date).toBe(PLUS_5)
  })

  it('a bare from (no to) collapses the window to that single day', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: TOMORROW })

    const sameDay = await listCatalog(AGENT_EMAIL, `?today=${TODAY}&from=${TODAY}`)
    expect(sameDay.services[0].has_availability).toBe(false) // tomorrow's slot is outside [TODAY,TODAY]
    const nextDay = await listCatalog(AGENT_EMAIL, `?today=${TODAY}&from=${TOMORROW}`)
    expect(nextDay.services[0].has_availability).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// US-AG56 / BUG-031 — the next departure that actually has room
// Spec: docs/pos/default-filtered-catalog.spec.md (Scenarios 12–17, D7–D14).
//
// Scenarios 1–11 above are left UNEDITED on purpose: they are the mechanical proof that
// US-AG30's contract survived this amendment. What they never arranged — and what the defect
// needed — is a sold-out departure standing IN FRONT OF an available one.
//
// The suite's clock is frozen at 2026-06-14T12:00Z and test orgs are seeded in UTC with a
// sales-cutoff offset of 0, so the cutoff threshold is exactly '2026-06-14T12:00'.
// ---------------------------------------------------------------------------
const CLOCK_DAY = '2026-06-14' // the frozen "now" day — used only by the cutoff scenario

describe('US-AG56 — the catalog names the next departure with room', () => {
  it('Scenario 12 — a sold-out earlier time does not win the day', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, name: 'Reef Snorkel' })
    // Same date, two departures: the morning is full, the afternoon has three seats.
    await seedSlot({ organizationId, serviceId, date: TOMORROW, startTime: '09:00', capacity: 12, booked: 12 })
    await seedSlot({ organizationId, serviceId, date: TOMORROW, startTime: '15:00', capacity: 12, booked: 9 })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    expect(services[0]).toMatchObject({
      has_availability: true,
      next_slot_date: TOMORROW,
      // The defect returned this date with no time at all; naming the earliest time ON it
      // would have been the same lie in a new field.
      next_slot_time: '15:00',
    })
  })

  it('Scenario 13 — a fully sold-out day yields to the next day', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: TODAY, startTime: '08:00', capacity: 12, booked: 12 })
    await seedSlot({ organizationId, serviceId, date: TODAY, startTime: '17:00', capacity: 12, booked: 12 })
    await seedSlot({ organizationId, serviceId, date: TOMORROW, startTime: '08:00', capacity: 12, booked: 0 })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    // Ordering is over the (date, time) PAIR — a sold-out earlier date cannot claim the answer.
    expect(services[0]).toMatchObject({
      has_availability: true,
      next_slot_date: TOMORROW,
      next_slot_time: '08:00',
    })
  })

  it('Scenario 14 — a negative slot cannot suppress a sellable sibling (BUG-031 (b))', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, isFlexible: false, flexCapacityPct: 0 })
    // The stranded departure: 43 seats were sold under a 10% Soft Cap margin (ceiling 44), then
    // an admin turned Soft Cap off. Effective remaining is now (40 - 43) + 0 = -3.
    await seedSlot({ organizationId, serviceId, date: TODAY, startTime: '09:00', capacity: 40, booked: 43 })
    // …and a sibling that genuinely has two seats.
    await seedSlot({ organizationId, serviceId, date: TOMORROW, startTime: '09:00', capacity: 12, booked: 10 })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    // The old Σ read -3 + 2 = -1 and reported "Agotado" — while the calendar Bottom Sheet,
    // which tests per slot, lit TOMORROW up. One screen, two answers.
    expect(services[0]).toMatchObject({
      has_availability: true,
      next_slot_date: TOMORROW,
      next_slot_time: '09:00',
    })
  })

  it('Scenario 15 — the Soft Cap margin alone can be the next departure', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, isFlexible: true, flexCapacityPct: 20 })
    // Full on raw capacity; floor(10 × 20 / 100) = 2 sellable margin seats (US-A36).
    await seedSlot({ organizationId, serviceId, date: TOMORROW, startTime: '07:30', capacity: 10, booked: 10 })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    expect(services[0]).toMatchObject({
      has_availability: true,
      next_slot_date: TOMORROW,
      next_slot_time: '07:30',
    })
  })

  it('Scenario 16 — a departure past the sales cutoff is never the answer', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    // Both have seats; the 10:00 has already departed against the frozen 12:00 threshold.
    await seedSlot({ organizationId, serviceId, date: CLOCK_DAY, startTime: '10:00', capacity: 12, booked: 0 })
    await seedSlot({ organizationId, serviceId, date: CLOCK_DAY, startTime: '18:00', capacity: 12, booked: 0 })

    const { services } = await listCatalog(
      AGENT_EMAIL,
      `?today=${CLOCK_DAY}&from=${CLOCK_DAY}&to=${CLOCK_DAY}`,
    )
    // US-A47 is unchanged by this amendment: the cutoff still runs before the has-room test.
    expect(services[0]).toMatchObject({
      has_availability: true,
      next_slot_date: CLOCK_DAY,
      next_slot_time: '18:00',
    })
  })

  it('a sold-out service reports both fields null (D12 — the named loss)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedSlot({ organizationId, serviceId, date: TODAY, startTime: '09:00', capacity: 12, booked: 12 })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    // The card drops its «Próximo» block entirely rather than naming a date nobody can sell.
    expect(services[0]).toMatchObject({
      has_availability: false,
      next_slot_date: null,
      next_slot_time: null,
    })
  })

  it('has_availability is derived from the departure, so they cannot disagree (D9)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId: openId } = await seedService({ organizationId, name: 'A Open' })
    await seedSlot({ organizationId, serviceId: openId, date: TODAY, startTime: '09:00', capacity: 12, booked: 1 })
    const { serviceId: fullId } = await seedService({ organizationId, name: 'B Full' })
    await seedSlot({ organizationId, serviceId: fullId, date: TODAY, startTime: '09:00', capacity: 12, booked: 12 })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    // The invariant, asserted over the whole payload rather than one row: the flag IS the
    // non-nullness of the departure. This is what makes the BUG-031 (b) contradiction
    // unrepresentable instead of merely untested.
    for (const s of services) {
      expect(s.has_availability).toBe(s.next_slot_date !== null)
      expect(s.next_slot_date === null).toBe(s.next_slot_time === null)
    }
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation (required — Scenario 11, B4)
// ---------------------------------------------------------------------------
describe('US-AG30 — multitenancy isolation', () => {
  it('Scenario 11 — B4: windowed availability is scoped to the caller org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: orgA.organizationId })
    const a = await seedService({ organizationId: orgA.organizationId, name: 'A Tour', category: 'tours' })
    await seedSlot({ organizationId: orgA.organizationId, serviceId: a.serviceId, date: TODAY })
    const b = await seedService({ organizationId: orgB.organizationId, name: 'B Dining', category: 'dining' })
    await seedSlot({ organizationId: orgB.organizationId, serviceId: b.serviceId, date: TODAY })

    const { services } = await listCatalog(AGENT_EMAIL, `?today=${TODAY}`)
    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({ name: 'A Tour', has_availability: true })
    // org B's slot can never set availability or seed a chip for org A.
    expect(services.some((s) => s.name === 'B Dining')).toBe(false)
  })
})
