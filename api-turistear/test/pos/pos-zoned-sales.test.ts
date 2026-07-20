import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Zoned Capacity (US-A64) — POS sell path (Phase 2). Scenarios 8–14, 29.
// A zoned line is guarded against its OWN `slot_zones` row (single-statement atomic UPDATE →
// 409 ZONE_UNAVAILABLE); `slots.capacity`/`booked` are reconciled from the zones so headline
// availability stays correct. Slot date 2026-06-15 mirrors the other POS sale tests (sellable in
// this sandbox's clock).

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const SLOT_DATE = '2026-06-15'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/pos'
const svcBase = 'http://api.local/api/services'
const ts = () => Math.floor(Date.now() / 1000)

// --- Raw D1 seeders --------------------------------------------------------

const seedService = async (organizationId: string, zonesEnabled = true): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        commission_type, commission_value, zones_enabled, category, status, created_at, updated_at)
     VALUES (?, ?, 'Turibus', NULL, 150000, 100000, 50, 'percent', 0, ?, 'tours', 'active', ?, ?)`,
  )
    .bind(id, organizationId, zonesEnabled ? 1 : 0, ts(), ts())
    .run()
  return id
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  capacity = 50,
  booked = 0,
): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', ?, ?, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, SLOT_DATE, capacity, booked, ts(), ts())
    .run()
  return id
}

const seedZone = async (
  organizationId: string,
  serviceId: string,
  name: string,
  capacity: number,
  sortOrder: number,
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
  booked: number,
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO slot_zones (id, organization_id, slot_id, zone_id, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(crypto.randomUUID(), organizationId, slotId, zoneId, capacity, booked, ts(), ts())
    .run()
}

// A zoned service with one slot and two zones (alto/bajo), seeded to the given booked levels.
const seedZoned = async (
  organizationId: string,
  altoBooked = 0,
  bajoBooked = 0,
  altoCap = 20,
  bajoCap = 30,
) => {
  const serviceId = await seedService(organizationId, true)
  const slotId = await seedSlot(organizationId, serviceId, altoCap + bajoCap, altoBooked + bajoBooked)
  const alto = await seedZone(organizationId, serviceId, 'Piso alto', altoCap, 0)
  const bajo = await seedZone(organizationId, serviceId, 'Piso bajo', bajoCap, 1)
  await seedSlotZone(organizationId, slotId, alto, altoCap, altoBooked)
  await seedSlotZone(organizationId, slotId, bajo, bajoCap, bajoBooked)
  return { serviceId, slotId, alto, bajo }
}

// --- Readers ---------------------------------------------------------------

const zoneBooked = async (slotId: string, zoneId: string): Promise<number> =>
  ((await env.DB.prepare('SELECT booked FROM slot_zones WHERE slot_id = ? AND zone_id = ?')
    .bind(slotId, zoneId)
    .first()) as { booked: number }).booked

const slotTotals = async (slotId: string) =>
  (await env.DB.prepare('SELECT capacity, booked FROM slots WHERE id = ?').bind(slotId).first()) as {
    capacity: number
    booked: number
  }

const countFolios = async (): Promise<number> =>
  ((await env.DB.prepare('SELECT COUNT(*) n FROM folios').first()) as { n: number }).n

const sell = (email: string, lines: object[]) =>
  SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ customer_email: 'cliente@example.com', lines }),
  })

const clearDb = async () => {
  // FK-safe: every child of folios/slots/service_zones before its parent.
  for (const t of [
    'folio_line_extras',
    'folio_access_tokens',
    'cancellation_requests',
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
  await clearDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
describe('US-A64 §3 — selling a zone', () => {
  it('Scenario 8 — a zoned sale decrements only its zone', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { slotId, alto, bajo } = await seedZoned(organizationId, 12, 5)

    const res = await sell(AGENT_EMAIL, [{ slot_id: slotId, zone_id: alto, quantity: 2, unit_price: 150000 }])
    expect(res.status).toBe(201)
    expect(await zoneBooked(slotId, alto)).toBe(14)
    expect(await zoneBooked(slotId, bajo)).toBe(5)
    expect(await slotTotals(slotId)).toMatchObject({ capacity: 50, booked: 19 })
  })

  it('Scenario 9 — a split party is two lines on one folio, two QR tokens', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { slotId, alto, bajo } = await seedZoned(organizationId, 0, 0)

    const res = await sell(AGENT_EMAIL, [
      { slot_id: slotId, zone_id: alto, quantity: 3, unit_price: 150000 },
      { slot_id: slotId, zone_id: bajo, quantity: 2, unit_price: 150000 },
    ])
    expect(res.status).toBe(201)
    expect(await zoneBooked(slotId, alto)).toBe(3)
    expect(await zoneBooked(slotId, bajo)).toBe(2)

    const lines = (await env.DB.prepare(
      'SELECT slot_id, zone_id, zone_name, qr_token FROM folio_lines ORDER BY zone_name',
    ).all()) as unknown as {
      results: { slot_id: string; zone_id: string; zone_name: string; qr_token: string | null }[]
    }
    expect(lines.results).toHaveLength(2)
    expect(lines.results.every((l) => l.slot_id === slotId)).toBe(true)
    expect(new Set(lines.results.map((l) => l.zone_id)).size).toBe(2)
    expect(lines.results.map((l) => l.zone_name).sort()).toEqual(['Piso alto', 'Piso bajo'])
    expect(lines.results.every((l) => !!l.qr_token)).toBe(true)
    expect(await countFolios()).toBe(1)
  })

  it('Scenario 10 — a zone is required on a zoned service', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { slotId } = await seedZoned(organizationId, 0, 0)
    const res = await sell(AGENT_EMAIL, [{ slot_id: slotId, quantity: 2, unit_price: 150000 }])
    expect(res.status).toBe(400)
    expect(await countFolios()).toBe(0)
  })

  it('Scenario 11 — a zone is refused on an unzoned service', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId, false)
    const slotId = await seedSlot(organizationId, serviceId, 50, 0)
    const res = await sell(AGENT_EMAIL, [
      { slot_id: slotId, zone_id: crypto.randomUUID(), quantity: 2, unit_price: 150000 },
    ])
    expect(res.status).toBe(400)
  })

  it('Scenario 12 — selling past a zone ceiling is blocked, nothing written', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { slotId, alto } = await seedZoned(organizationId, 19, 0) // alto 19/20, bus has 31 free
    const res = await sell(AGENT_EMAIL, [{ slot_id: slotId, zone_id: alto, quantity: 2, unit_price: 150000 }])
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('ZONE_UNAVAILABLE')
    expect(await zoneBooked(slotId, alto)).toBe(19)
    expect(await countFolios()).toBe(0)
  })

  it('Scenario 13 — a full zone does not block a different one', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { slotId, bajo } = await seedZoned(organizationId, 20, 5) // alto sold out 20/20
    const res = await sell(AGENT_EMAIL, [{ slot_id: slotId, zone_id: bajo, quantity: 2, unit_price: 150000 }])
    expect(res.status).toBe(201)
    expect(await zoneBooked(slotId, bajo)).toBe(7)
  })

  it('Scenario 14 — concurrent sales into the last seat of a zone: exactly one wins', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { slotId, alto } = await seedZoned(organizationId, 19, 0) // exactly 1 seat left in alto

    const [a, b] = await Promise.all([
      sell(AGENT_EMAIL, [{ slot_id: slotId, zone_id: alto, quantity: 1, unit_price: 150000 }]),
      sell(AGENT_EMAIL, [{ slot_id: slotId, zone_id: alto, quantity: 1, unit_price: 150000 }]),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([201, 409])
    // The counter never exceeds the ceiling.
    expect(await zoneBooked(slotId, alto)).toBe(20)
    expect(await countFolios()).toBe(1)
  })

  it('POS payload — the service-detail read exposes per-slot zones', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId, slotId, alto } = await seedZoned(organizationId, 12, 5)

    const res = await SELF.fetch(`${base}/services/${serviceId}?from=2026-06-10`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      service: {
        zones_enabled: boolean
        slots: { id: string; zones?: { zone_id: string; remaining: number; status: string }[] }[]
      }
    }
    expect(body.service.zones_enabled).toBe(true)
    const slot = body.service.slots.find((s) => s.id === slotId)!
    expect(slot.zones).toHaveLength(2)
    const altoZone = slot.zones!.find((z) => z.zone_id === alto)!
    expect(altoZone).toMatchObject({ remaining: 8, status: 'active' }) // 20 cap − 12 booked
  })

  it('Scenario 22/23 — closing a zone for one departure blocks new sales; reopen restores it', async () => {
    // The agent sells; the admin closes/reopens. Both in the same org.
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await seedUser({ email: ADMIN_EMAIL, role: 'admin', organizationId })
    const { serviceId, slotId, alto, bajo } = await seedZoned(organizationId, 8, 5) // alto 8/20, bajo 5/30

    // Close alto on this departure.
    const close = await SELF.fetch(
      `${svcBase}/${serviceId}/slots/${slotId}/zones/${alto}/close`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    expect(close.status).toBe(200)
    // The departure reprices: alto drops out of BOTH capacity and booked (only bajo counts).
    expect(await slotTotals(slotId)).toMatchObject({ capacity: 30, booked: 5 })
    // Its 8 sold seats remain on the zone row (they're valid; the close only stops new sales).
    expect(await zoneBooked(slotId, alto)).toBe(8)

    // A new sale into the closed zone is refused.
    const blocked = await sell(AGENT_EMAIL, [
      { slot_id: slotId, zone_id: alto, quantity: 1, unit_price: 150000 },
    ])
    expect(blocked.status).toBe(409)
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('ZONE_UNAVAILABLE')
    // bajo still sells fine.
    const ok = await sell(AGENT_EMAIL, [{ slot_id: slotId, zone_id: bajo, quantity: 1, unit_price: 150000 }])
    expect(ok.status).toBe(201)

    // Reopen restores alto to the derived totals.
    const reopen = await SELF.fetch(
      `${svcBase}/${serviceId}/slots/${slotId}/zones/${alto}/reopen`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    expect(reopen.status).toBe(200)
    expect(await slotTotals(slotId)).toMatchObject({ capacity: 50, booked: 14 }) // 8 alto + 6 bajo
  })

  it('Scenario 29 — B3: a foreign zone_id cannot be sold into', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    // Agent belongs to org A; the service + slot + zones are org A's.
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: orgA.organizationId })
    const { slotId } = await seedZoned(orgA.organizationId, 0, 0)
    // A zone that belongs to org B (its own zoned service) — must be unreachable from org A's sale.
    const svcB = await seedService(orgB.organizationId, true)
    const foreignZone = await seedZone(orgB.organizationId, svcB, 'B-alto', 20, 0)

    const res = await sell(AGENT_EMAIL, [
      { slot_id: slotId, zone_id: foreignZone, quantity: 1, unit_price: 150000 },
    ])
    expect(res.status).toBe(404)
    expect(await countFolios()).toBe(0)
  })
})
