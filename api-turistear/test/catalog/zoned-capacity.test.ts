import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Zoned Capacity (US-A64 — docs/catalog/zoned-capacity.spec.md). Phase 1: admin zone definitions,
// enable/disable, editing. Scenarios 1–7, 18–21, 24 + multitenancy 27, 28, 30.
// (The sell/release/close/scanner scenarios land in later phases.)
//
// Wall-clock independence: "future" departures are dated far ahead (2099) and "past" ones far back
// (2020), so the future/past partition (`slot.date >= today`) is deterministic regardless of when
// the suite runs. The `enable` endpoint also accepts an explicit `today` for the same reason.

const ADMIN_EMAIL = 'admin@empresa.com'
const FUTURE = '2099-06-15'
const PAST = '2020-06-15'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/services'
const ts = () => Math.floor(Date.now() / 1000)

// --- Raw D1 seeders --------------------------------------------------------

interface SeedServiceOpts {
  organizationId: string
  name?: string
  defaultCapacity?: number
  isFlexible?: boolean
  flexPct?: number
  zonesEnabled?: boolean
  category?: string | null
}
const seedService = async (o: SeedServiceOpts): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        is_flexible, flex_capacity_pct, zones_enabled, category, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 150000, 100000, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(
      id,
      o.organizationId,
      o.name ?? 'Turibus',
      o.defaultCapacity ?? 50,
      o.isFlexible ? 1 : 0,
      o.flexPct ?? 0,
      o.zonesEnabled ? 1 : 0,
      o.category ?? 'tours',
      ts(),
      ts(),
    )
    .run()
  return id
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  opts: { date?: string; capacity?: number; booked?: number } = {},
): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '10:00', ?, ?, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, opts.date ?? FUTURE, opts.capacity ?? 50, opts.booked ?? 0, ts(), ts())
    .run()
  return id
}

const seedZone = async (
  organizationId: string,
  serviceId: string,
  name: string,
  capacity: number,
  sortOrder = 0,
): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO service_zones (id, organization_id, service_id, name, capacity, sort_order, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, name, capacity, sortOrder, ts(), ts())
    .run()
  return id
}

const seedSlotZone = async (
  organizationId: string,
  slotId: string,
  zoneId: string,
  capacity: number,
  booked = 0,
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO slot_zones (id, organization_id, slot_id, zone_id, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(crypto.randomUUID(), organizationId, slotId, zoneId, capacity, booked, ts(), ts())
    .run()
}

// A paid folio with one slot line of `quantity` seats (optionally already tagged to a zone).
// `agentId` must be a real user (folios.agent_id → users.id) — pass the seeded admin's userId.
const seedFolioLine = async (
  organizationId: string,
  agentId: string,
  serviceId: string,
  slotId: string,
  slotDate: string,
  quantity: number,
  zone?: { id: string; name: string },
): Promise<void> => {
  const folioId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios (id, organization_id, agent_id, status, payment_method, subtotal, discount_total, total, amount_paid, commission_amount, created_at, updated_at)
     VALUES (?, ?, ?, 'paid', 'cash', 150000, 0, 150000, 150000, 0, ?, ?)`,
  )
    .bind(folioId, organizationId, agentId, ts(), ts())
    .run()
  await env.DB.prepare(
    `INSERT INTO folio_lines
       (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date, slot_start_time,
        quantity, base_price, minimum_price, unit_price, line_total, commission_type, commission_value,
        line_type, zone_id, zone_name, created_at)
     VALUES (?, ?, ?, ?, ?, 'Turibus', ?, '10:00', ?, 150000, 100000, 150000, 150000, 'percent', 0, 'slot', ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      organizationId,
      folioId,
      serviceId,
      slotId,
      slotDate,
      quantity,
      zone?.id ?? null,
      zone?.name ?? null,
      ts(),
    )
    .run()
}

// --- Raw D1 readers --------------------------------------------------------

const getSlot = async (slotId: string) =>
  (await env.DB.prepare('SELECT capacity, booked FROM slots WHERE id = ?').bind(slotId).first()) as
    | { capacity: number; booked: number }
    | null

const getSlotZone = async (slotId: string, zoneId: string) =>
  (await env.DB.prepare('SELECT capacity, booked, status FROM slot_zones WHERE slot_id = ? AND zone_id = ?')
    .bind(slotId, zoneId)
    .first()) as { capacity: number; booked: number; status: string } | null

const countSlotZones = async (slotId: string): Promise<number> =>
  ((await env.DB.prepare('SELECT COUNT(*) n FROM slot_zones WHERE slot_id = ?').bind(slotId).first()) as {
    n: number
  }).n

const getServiceFlags = async (serviceId: string) =>
  (await env.DB.prepare('SELECT zones_enabled, is_flexible, flex_capacity_pct FROM services WHERE id = ?')
    .bind(serviceId)
    .first()) as { zones_enabled: number; is_flexible: number; flex_capacity_pct: number }

const getFolioLineZone = async (serviceId: string) =>
  (await env.DB.prepare('SELECT zone_id, zone_name FROM folio_lines WHERE service_id = ? LIMIT 1')
    .bind(serviceId)
    .first()) as { zone_id: string | null; zone_name: string | null } | null

const clearZoneDb = async () => {
  // FK-safe order: children before parents. folio_lines & slot_zones both reference service_zones
  // and slots, so they must go before those.
  for (const t of [
    'folio_line_extras',
    'slot_zones',
    'folio_lines',
    'folios',
    'service_zones',
    'slots',
    'schedules',
    'services',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}

beforeEach(async () => {
  await clearZoneDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

// Convenience: enable zones and return the parsed body.
const enable = (serviceId: string, body: object) =>
  SELF.fetch(`${base}/${serviceId}/zones/enable`, {
    method: 'POST',
    headers: jsonAuth(ADMIN_EMAIL),
    body: JSON.stringify(body),
  })

// ---------------------------------------------------------------------------
// US-A64 §1 — Defining zones
// ---------------------------------------------------------------------------
describe('US-A64 §1 — defining zones', () => {
  it('Scenario 1 — a service is unzoned by default', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const res = await SELF.fetch(base, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'Plain Tour',
        base_price: 150000,
        minimum_price: 100000,
        default_capacity: 12,
        category: 'tours',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { service: { id: string; zones_enabled: boolean } }
    expect(body.service.zones_enabled).toBe(false)
    const zones = await env.DB.prepare('SELECT COUNT(*) n FROM service_zones WHERE service_id = ?')
      .bind(body.service.id)
      .first()
    expect((zones as { n: number }).n).toBe(0)
    void organizationId
  })

  it('Scenario 2 — enabling zones requires at least two', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const serviceId = await seedService({ organizationId })
    const res = await enable(serviceId, { zones: [{ name: 'Piso alto', capacity: 20 }] })
    expect(res.status).toBe(400)
    expect(getServiceFlags(serviceId).then((s) => s.zones_enabled)).resolves.toBe(0)
  })

  it('Scenario 3 — duplicate zone names are rejected', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const serviceId = await seedService({ organizationId })
    await enable(serviceId, {
      zones: [
        { name: 'Piso alto', capacity: 20 },
        { name: 'Piso bajo', capacity: 30 },
      ],
    })
    const res = await SELF.fetch(`${base}/${serviceId}/zones`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'piso alto', capacity: 10 }),
    })
    expect(res.status).toBe(409)
  })

  it('Scenario 4 — enabling zones clears Soft Cap', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const serviceId = await seedService({ organizationId, isFlexible: true, flexPct: 10 })
    const res = await enable(serviceId, {
      zones: [
        { name: 'Piso alto', capacity: 20 },
        { name: 'Piso bajo', capacity: 30 },
      ],
    })
    expect(res.status).toBe(200)
    const flags = await getServiceFlags(serviceId)
    expect(flags).toMatchObject({ zones_enabled: 1, is_flexible: 0, flex_capacity_pct: 0 })
  })

  it('Scenario 5 — future departures inherit the derived capacity; past untouched', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const serviceId = await seedService({ organizationId })
    const futureSlot = await seedSlot(organizationId, serviceId, { date: '2026-12-15', capacity: 40 })
    const pastSlot = await seedSlot(organizationId, serviceId, { date: '2025-06-01', capacity: 40 })

    const res = await enable(serviceId, {
      today: '2026-01-01',
      zones: [
        { name: 'Piso alto', capacity: 20 },
        { name: 'Piso bajo', capacity: 30 },
      ],
    })
    expect(res.status).toBe(200)
    expect((await getSlot(futureSlot))?.capacity).toBe(50)
    expect(await countSlotZones(futureSlot)).toBe(2)
    // Past slot keeps its original capacity and gets NO zone rows.
    expect((await getSlot(pastSlot))?.capacity).toBe(40)
    expect(await countSlotZones(pastSlot)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// US-A64 §2 — Enabling with seats already sold
// ---------------------------------------------------------------------------
describe('US-A64 §2 — enabling with existing sales', () => {
  it('Scenario 6 — existing sold seats are assigned to a zone and lines are backfilled', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN_EMAIL })
    const serviceId = await seedService({ organizationId })
    const slotId = await seedSlot(organizationId, serviceId, { date: '2026-12-15', capacity: 40, booked: 8 })
    await seedFolioLine(organizationId, userId, serviceId, slotId, '2026-12-15', 8)

    const res = await enable(serviceId, {
      today: '2026-01-01',
      assign_existing_to: 1, // Piso bajo
      zones: [
        { name: 'Piso alto', capacity: 20 },
        { name: 'Piso bajo', capacity: 30 },
      ],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { zones: { id: string; name: string }[] }
    const bajo = body.zones.find((z) => z.name === 'Piso bajo')!
    const alto = body.zones.find((z) => z.name === 'Piso alto')!

    expect((await getSlotZone(slotId, bajo.id))?.booked).toBe(8)
    expect((await getSlotZone(slotId, alto.id))?.booked).toBe(0)
    expect(await getSlot(slotId)).toMatchObject({ capacity: 50, booked: 8 })

    const line = await getFolioLineZone(serviceId)
    expect(line?.zone_id).toBe(bajo.id)
    expect(line?.zone_name).toBe('Piso bajo')
  })

  it('Scenario 6b — enable is rejected when future sales exist but no zone is chosen', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const serviceId = await seedService({ organizationId })
    await seedSlot(organizationId, serviceId, { date: '2026-12-15', capacity: 40, booked: 5 })
    const res = await enable(serviceId, {
      today: '2026-01-01',
      zones: [
        { name: 'A', capacity: 20 },
        { name: 'B', capacity: 30 },
      ],
    })
    expect(res.status).toBe(400)
    expect((await getServiceFlags(serviceId)).zones_enabled).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// US-A64 §5 — Editing zones
// ---------------------------------------------------------------------------
describe('US-A64 §5 — editing zones', () => {
  // Seed a zoned service with two zones and one future departure carrying `bookedAlto` sold in alto.
  const seedZoned = async (organizationId: string, bookedAlto = 0) => {
    const serviceId = await seedService({ organizationId, zonesEnabled: true })
    const alto = await seedZone(organizationId, serviceId, 'Piso alto', 20, 0)
    const bajo = await seedZone(organizationId, serviceId, 'Piso bajo', 30, 1)
    const slotId = await seedSlot(organizationId, serviceId, { date: FUTURE, capacity: 50, booked: bookedAlto })
    await seedSlotZone(organizationId, slotId, alto, 20, bookedAlto)
    await seedSlotZone(organizationId, slotId, bajo, 30, 0)
    return { serviceId, alto, bajo, slotId }
  }

  it('Scenario 18 — rename does not rewrite sold tickets', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId, alto, slotId } = await seedZoned(organizationId, 3)
    await seedFolioLine(organizationId, userId, serviceId, slotId, FUTURE, 3, { id: alto, name: 'Piso alto' })

    const res = await SELF.fetch(`${base}/${serviceId}/zones/${alto}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'Terraza', capacity: 20 }),
    })
    expect(res.status).toBe(200)
    // The sold line keeps its snapshot; the definition changed.
    expect((await getFolioLineZone(serviceId))?.zone_name).toBe('Piso alto')
    const def = await env.DB.prepare('SELECT name FROM service_zones WHERE id = ?').bind(alto).first()
    expect((def as { name: string }).name).toBe('Terraza')
  })

  it('Scenario 19 — shrinking below sold seats is rejected', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId, alto } = await seedZoned(organizationId, 8)
    const res = await SELF.fetch(`${base}/${serviceId}/zones/${alto}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'Piso alto', capacity: 6 }),
    })
    expect(res.status).toBe(409)
    const def = await env.DB.prepare('SELECT capacity FROM service_zones WHERE id = ?').bind(alto).first()
    expect((def as { capacity: number }).capacity).toBe(20)
  })

  it('Scenario 19b — growing capacity re-snapshots future departures', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId, alto, slotId } = await seedZoned(organizationId, 0)
    const res = await SELF.fetch(`${base}/${serviceId}/zones/${alto}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'Piso alto', capacity: 26 }),
    })
    expect(res.status).toBe(200)
    expect((await getSlotZone(slotId, alto))?.capacity).toBe(26)
    expect((await getSlot(slotId))?.capacity).toBe(56) // 26 + 30
  })

  it('Scenario 20 — deleting a zone with sales is refused; deactivating works', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId, alto, slotId } = await seedZoned(organizationId, 4)
    // Need a 3rd zone so deactivate can keep ≥ 2 active.
    const terraza = await seedZone(organizationId, serviceId, 'Terraza', 10, 2)
    await seedSlotZone(organizationId, slotId, terraza, 10, 0)

    const del = await SELF.fetch(`${base}/${serviceId}/zones/${alto}`, {
      method: 'DELETE',
      headers: auth(ADMIN_EMAIL),
    })
    expect(del.status).toBe(409)

    const deact = await SELF.fetch(`${base}/${serviceId}/zones/${alto}/deactivate`, {
      method: 'POST',
      headers: auth(ADMIN_EMAIL),
    })
    expect(deact.status).toBe(200)
    expect((await getSlotZone(slotId, alto))?.status).toBe('inactive')
    // Derived capacity drops the deactivated zone (30 bajo + 10 terraza), booked drops alto's 4.
    expect(await getSlot(slotId)).toMatchObject({ capacity: 40, booked: 0 })
  })

  it('Scenario 21 — per-slot capacity edits are refused on a zoned service', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { serviceId, slotId } = await seedZoned(organizationId, 0)
    const res = await SELF.fetch(`${base}/${serviceId}/slots/${slotId}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ date: FUTURE, start_time: '10:00', capacity: 99 }),
    })
    expect(res.status).toBe(400)
    expect((await getSlot(slotId))?.capacity).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// US-A64 §7 — Disabling
// ---------------------------------------------------------------------------
describe('US-A64 §7 — disabling', () => {
  it('Scenario 24 — disabling collapses to one pool and keeps history', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN_EMAIL })
    const serviceId = await seedService({ organizationId, zonesEnabled: true })
    const alto = await seedZone(organizationId, serviceId, 'Piso alto', 20, 0)
    const bajo = await seedZone(organizationId, serviceId, 'Piso bajo', 30, 1)
    const slotId = await seedSlot(organizationId, serviceId, { date: FUTURE, capacity: 50, booked: 5 })
    await seedSlotZone(organizationId, slotId, alto, 20, 0)
    await seedSlotZone(organizationId, slotId, bajo, 30, 5)
    await seedFolioLine(organizationId, userId, serviceId, slotId, FUTURE, 5, { id: bajo, name: 'Piso bajo' })

    const res = await SELF.fetch(`${base}/${serviceId}/zones/disable`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect((await getServiceFlags(serviceId)).zones_enabled).toBe(0)
    // Future slot keeps the summed pool; its zone rows are gone; the sold line keeps its zone name.
    expect(await getSlot(slotId)).toMatchObject({ capacity: 50, booked: 5 })
    expect(await countSlotZones(slotId)).toBe(0)
    expect((await getFolioLineZone(serviceId))?.zone_name).toBe('Piso bajo')
  })
})

// ---------------------------------------------------------------------------
// Hard-delete cascade (US-A58 + US-A64)
// ---------------------------------------------------------------------------
describe('US-A64 — hard-delete cascades the zone tables', () => {
  it('deleting a zoned service removes its slot_zones / service_zones (no FK error)', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const serviceId = await seedService({ organizationId, zonesEnabled: true })
    const alto = await seedZone(organizationId, serviceId, 'Piso alto', 20, 0)
    const bajo = await seedZone(organizationId, serviceId, 'Piso bajo', 30, 1)
    const slotId = await seedSlot(organizationId, serviceId, { date: FUTURE })
    await seedSlotZone(organizationId, slotId, alto, 20, 0)
    await seedSlotZone(organizationId, slotId, bajo, 30, 0)

    const res = await SELF.fetch(`${base}/${serviceId}`, { method: 'DELETE', headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(200)

    const rows = (await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM services WHERE id = ?) AS svc,
         (SELECT COUNT(*) FROM service_zones WHERE service_id = ?) AS zones,
         (SELECT COUNT(*) FROM slot_zones WHERE slot_id = ?) AS slotZones,
         (SELECT COUNT(*) FROM slots WHERE service_id = ?) AS slots`,
    )
      .bind(serviceId, serviceId, slotId, serviceId)
      .first()) as { svc: number; zones: number; slotZones: number; slots: number }
    expect(rows).toMatchObject({ svc: 0, zones: 0, slotZones: 0, slots: 0 })
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation (seedTwoOrgs)
// ---------------------------------------------------------------------------
describe('US-A64 — multitenancy isolation', () => {
  it('Scenario 27 — B1: an injected organizationId is ignored on enable', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceId = await seedService({ organizationId: orgA.organizationId })
    const res = await SELF.fetch(`${base}/${serviceId}/zones/enable`, {
      method: 'POST',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        organizationId: orgB.organizationId, // must be stripped (Rule 1)
        zones: [
          { name: 'A', capacity: 20 },
          { name: 'B', capacity: 30 },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const row = (await env.DB.prepare('SELECT organization_id FROM service_zones WHERE service_id = ? LIMIT 1')
      .bind(serviceId)
      .first()) as { organization_id: string }
    expect(row.organization_id).toBe(orgA.organizationId)
  })

  it('Scenario 28 — B3: a foreign service’s zones are unreachable', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceId = await seedService({ organizationId: orgB.organizationId, zonesEnabled: true })
    await seedZone(orgB.organizationId, serviceId, 'Piso alto', 20)

    const list = await SELF.fetch(`${base}/${serviceId}/zones`, { headers: auth(orgA.adminEmail) })
    expect(list.status).toBe(404)
  })

  it('Scenario 30 — B4: zone lists are org-scoped', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const svcA = await seedService({ organizationId: orgA.organizationId, zonesEnabled: true, name: 'A-bus' })
    const svcB = await seedService({ organizationId: orgB.organizationId, zonesEnabled: true, name: 'B-bus' })
    await seedZone(orgA.organizationId, svcA, 'A-alto', 20)
    await seedZone(orgB.organizationId, svcB, 'B-alto', 20)

    const aRes = await SELF.fetch(`${base}/${svcA}/zones`, { headers: auth(orgA.adminEmail) })
    const aBody = (await aRes.json()) as { zones: { name: string }[] }
    expect(aBody.zones.map((z) => z.name)).toEqual(['A-alto'])
    // org A cannot see org B's service at all.
    const crossRes = await SELF.fetch(`${base}/${svcB}/zones`, { headers: auth(orgA.adminEmail) })
    expect(crossRes.status).toBe(404)
  })
})
