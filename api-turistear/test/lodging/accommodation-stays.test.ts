import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearAffiliateDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import {
  quoteStay,
  checkTypeAvailable,
  minRemaining,
  remainingOnNight,
  splitGuests,
  nightsBetween,
  rangesOverlap,
  type UnitTypeRateInfo,
} from '../../src/utils/lodging'

// Accommodation Stays v2 — UNIT-TYPE inventory (docs/lodging/accommodation-stays.spec.md, per the
// approved docs/RFCs/rfc-airbnb-inventory-model.md). Covers the engine (quantity quoting, per-night
// remaining), the admin unit-types/seasons/quantity-blockouts API (US-A59–A62), the POS reads
// (range-first + type calendar + flattened catalog, US-AG36/37), the per-night count guard at
// confirmSale (D10 — incl. the false-409 shape and the last-room race), the commission waterfall,
// and multitenancy isolation (B1/B3/B4 via seedTwoOrgs).

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

// --- Local seeders (raw D1) ---

const seedLodgingService = async (
  organizationId: string,
  name = 'Riverside Cabins',
  commission: { type?: 'percent' | 'fixed'; value?: number } = {},
): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        commission_type, commission_value, category, status)
     VALUES (?, ?, ?, ?, 0, 0, 1, ?, ?, 'lodging', 'active')`,
  )
    .bind(serviceId, organizationId, name, null, commission.type ?? 'percent', commission.value ?? 0)
    .run()
  return { serviceId }
}

const seedTourService = async (organizationId: string): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        commission_type, commission_value, category, status)
     VALUES (?, ?, 'Canyon Tour', null, 150000, 100000, 12, 'percent', 1000, 'tours', 'active')`,
  )
    .bind(serviceId, organizationId)
    .run()
  return { serviceId }
}

interface SeedTypeOpts {
  organizationId: string
  serviceId: string
  name?: string
  inventoryCount?: number
  baseRate?: number
  weekendRate?: number | null
  extraPersonFee?: number
  baseOccupancy?: number
  maxCapacity?: number
  minNights?: number
  amenities?: string
  status?: 'active' | 'inactive'
  commissionType?: 'percent' | 'fixed' | null
  commissionValue?: number | null
}

const seedUnitType = async (o: SeedTypeOpts): Promise<{ typeId: string }> => {
  const typeId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO accommodation_unit_types
       (id, organization_id, service_id, name, unit_type, inventory_count, beds, base_occupancy,
        max_capacity, base_rate, weekend_rate, extra_person_fee, min_nights, checkin_time,
        checkout_time, amenities, commission_type, commission_value, status)
     VALUES (?, ?, ?, ?, 'cabin', ?, 2, ?, ?, ?, ?, ?, ?, '15:00', '11:00', ?, ?, ?, ?)`,
  )
    .bind(
      typeId,
      o.organizationId,
      o.serviceId,
      o.name ?? 'Cabaña Río',
      o.inventoryCount ?? 1,
      o.baseOccupancy ?? 2,
      o.maxCapacity ?? 4,
      o.baseRate ?? 100000,
      o.weekendRate ?? null,
      o.extraPersonFee ?? 0,
      o.minNights ?? 1,
      o.amenities ?? '',
      o.commissionType ?? null,
      o.commissionValue ?? null,
      o.status ?? 'active',
    )
    .run()
  return { typeId }
}

const seedSeason = async (
  organizationId: string,
  serviceId: string,
  typeId: string,
  startDate: string,
  endDate: string,
  nightlyRate: number,
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO accommodation_seasons
       (id, organization_id, service_id, unit_type_id, name, start_date, end_date, nightly_rate, status)
     VALUES (?, ?, ?, ?, 'Temporada', ?, ?, ?, 'active')`,
  )
    .bind(crypto.randomUUID(), organizationId, serviceId, typeId, startDate, endDate, nightlyRate)
    .run()
}

const seedBlockout = async (
  organizationId: string,
  serviceId: string,
  typeId: string,
  startDate: string,
  endDate: string,
  quantity = 1,
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO accommodation_blockouts
       (id, organization_id, service_id, unit_type_id, quantity, start_date, end_date, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, null)`,
  )
    .bind(crypto.randomUUID(), organizationId, serviceId, typeId, quantity, startDate, endDate)
    .run()
}

const seedReservation = async (
  organizationId: string,
  serviceId: string,
  typeId: string,
  checkIn: string,
  checkOut: string,
  status: 'active' | 'cancelled' = 'active',
  quantity = 1,
): Promise<void> => {
  // A reservation needs a folio (FK). Seed a minimal paid folio first.
  const folioId = crypto.randomUUID()
  const admin = await env.DB.prepare('SELECT id FROM users WHERE organization_id = ? LIMIT 1')
    .bind(organizationId)
    .first<{ id: string }>()
  await env.DB.prepare(
    `INSERT INTO folios (id, organization_id, agent_id, status, payment_method, subtotal,
       discount_total, total, amount_paid)
     VALUES (?, ?, ?, 'paid', 'cash', 0, 0, 0, 0)`,
  )
    .bind(folioId, organizationId, admin!.id)
    .run()
  await env.DB.prepare(
    `INSERT INTO accommodation_reservations
       (id, organization_id, service_id, unit_type_id, quantity, folio_id, check_in, check_out, guests, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      organizationId,
      serviceId,
      typeId,
      quantity,
      folioId,
      checkIn,
      checkOut,
      status,
    )
    .run()
}

let orgId: string

beforeEach(async () => {
  // Clear the accommodation tables FIRST — they reference services/folios, which clearAffiliateDb
  // deletes (FK order). folio_lines carries unit_type_id → accommodation_unit_types, so folio
  // lines must be cleared before the types. Order: reservations → folio line rows →
  // seasons/blockouts → unit types.
  for (const t of [
    'accommodation_reservations',
    'folio_line_extras',
    'folio_lines',
    'accommodation_seasons',
    'accommodation_blockouts',
    'accommodation_unit_types',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
  await clearAffiliateDb()
  const seeded = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  orgId = seeded.organizationId
  await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: orgId })
})

// ============================================================================
// Engine unit tests (pure — spec §3, scenarios 6/7/10 + D12 quantity math)
// ============================================================================

describe('lodging engine', () => {
  const unitType: UnitTypeRateInfo = {
    baseRate: 100000,
    weekendRate: 140000,
    extraPersonFee: 30000,
    baseOccupancy: 2,
    maxCapacity: 4,
    minNights: 1,
  }

  it('Sc6 — rate precedence seasonal > weekend > base', () => {
    // 2026-12-19 is a Saturday (weekend); season covers 12-20..12-31.
    const seasons = [{ startDate: '2026-12-20', endDate: '2026-12-31', nightlyRate: 200000 }]
    const q = quoteStay(unitType, '2026-12-19', '2026-12-22', 2, 1, seasons, [5, 6])
    // night 19 (Sat, weekend) 140000 + night 20 (season) 200000 + night 21 (season) 200000
    expect(q.nights).toBe(3)
    expect(q.total).toBe(140000 + 200000 + 200000)
  })

  it('Sc7 — extra-person surcharge per night, even split across rooms (D12)', () => {
    // 1 room, 3 nights, 3 guests (1 over base occupancy of 2) → +30000 × 3 nights. All weekdays.
    const one = quoteStay(unitType, '2026-07-13', '2026-07-16', 3, 1, [], [5, 6])
    expect(one.total).toBe(100000 * 3 + 30000 * 3)

    // 2 rooms, 5 guests → split [3, 2]: room 1 has 1 extra guest, room 2 none.
    // total = 2 rooms × 100000 × 3 nights + 30000 × 3 nights.
    const two = quoteStay(unitType, '2026-07-13', '2026-07-16', 5, 2, [], [5, 6])
    expect(two.total).toBe(2 * 100000 * 3 + 30000 * 3)
    // 4 guests / 2 rooms → [2, 2]: no extras at all.
    const even = quoteStay(unitType, '2026-07-13', '2026-07-16', 4, 2, [], [5, 6])
    expect(even.total).toBe(2 * 100000 * 3)
  })

  it('splitGuests distributes as evenly as possible', () => {
    expect(splitGuests(5, 2)).toEqual([3, 2])
    expect(splitGuests(4, 2)).toEqual([2, 2])
    expect(splitGuests(7, 3)).toEqual([3, 2, 2])
    expect(splitGuests(2, 1)).toEqual([2])
  })

  it('Sc10 — checkout-day reuse (half-open turnover)', () => {
    expect(rangesOverlap('2026-07-10', '2026-07-12', '2026-07-12', '2026-07-14')).toBe(false)
    expect(rangesOverlap('2026-07-10', '2026-07-13', '2026-07-12', '2026-07-14')).toBe(true)
  })

  it('nightsBetween counts nights, not days', () => {
    expect(nightsBetween('2026-07-10', '2026-07-13')).toBe(3)
  })

  it('per-night remaining sums reservations and blockouts covering each night', () => {
    const occ = [
      { start: '2026-07-10', end: '2026-07-12', quantity: 1 }, // reservation
      { start: '2026-07-11', end: '2026-07-13', quantity: 2 }, // blockout
    ]
    expect(remainingOnNight(3, '2026-07-10', occ)).toBe(2)
    expect(remainingOnNight(3, '2026-07-11', occ)).toBe(0) // 1 + 2 taken
    expect(remainingOnNight(3, '2026-07-12', occ)).toBe(1)
    expect(remainingOnNight(3, '2026-07-13', occ)).toBe(3)
    expect(minRemaining(3, '2026-07-10', '2026-07-14', occ)).toBe(0)
  })

  it('checkTypeAvailable enforces min-stay, capacity × quantity, and per-night inventory', () => {
    const t = { status: 'active', inventoryCount: 2, maxCapacity: 4, minNights: 2 }
    expect(checkTypeAvailable(t, '2026-07-10', '2026-07-11', 2, 1, [])).toBe('MIN_STAY_NOT_MET')
    // 1 room caps at 4 guests; 2 rooms cap at 8.
    expect(checkTypeAvailable(t, '2026-07-10', '2026-07-13', 5, 1, [])).toBe('OVER_CAPACITY')
    expect(checkTypeAvailable(t, '2026-07-10', '2026-07-13', 5, 2, [])).toBeNull()
    // Both rooms taken on a middle night → insufficient.
    expect(
      checkTypeAvailable(t, '2026-07-10', '2026-07-13', 2, 1, [
        { start: '2026-07-11', end: '2026-07-12', quantity: 2 },
      ]),
    ).toBe('INSUFFICIENT_INVENTORY')
    expect(checkTypeAvailable(t, '2026-07-10', '2026-07-13', 2, 2, [])).toBeNull()
  })
})

// ============================================================================
// Admin API — unit types (US-A59)
// ============================================================================

describe('admin unit types', () => {
  it('Sc1 — creates a unit type with an inventory count', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'Habitación Estándar',
        inventory_count: 12,
        beds: 2,
        base_occupancy: 2,
        max_capacity: 4,
        base_rate: 150000,
        amenities: ['wifi', 'parking'],
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      unit_type: { id: string; inventory_count: number; amenities: string[]; status: string }
    }
    expect(body.unit_type.inventory_count).toBe(12)
    expect(body.unit_type.amenities).toEqual(['wifi', 'parking'])
    expect(body.unit_type.status).toBe('active')
  })

  it('inventory_count defaults to 1 (boutique case)', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'Cabaña Río', beds: 2, base_occupancy: 2, max_capacity: 4, base_rate: 150000,
      }),
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { unit_type: { inventory_count: number } }).unit_type.inventory_count).toBe(1)
  })

  it('Sc2 — rejects max_capacity < base_occupancy and inventory_count < 1', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const cap = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'X', beds: 1, base_occupancy: 4, max_capacity: 2, base_rate: 1000 }),
    })
    expect(cap.status).toBe(400)
    const inv = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'X', inventory_count: 0, beds: 1, base_occupancy: 1, max_capacity: 2, base_rate: 1000,
      }),
    })
    expect(inv.status).toBe(400)
  })

  it('Sc3 — rejects a unit type on a non-lodging service', async () => {
    const { serviceId } = await seedTourService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'X', beds: 1, base_occupancy: 1, max_capacity: 2, base_rate: 1000 }),
    })
    expect(res.status).toBe(400)
  })

  it('Sc11 — rejects an unknown amenity key', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'X', beds: 1, base_occupancy: 1, max_capacity: 2, base_rate: 1000, amenities: ['spa'],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('Sc4 — deactivate / reactivate, agent forbidden', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId })

    const off = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/unit-types/${typeId}/deactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    expect(off.status).toBe(200)
    expect(((await off.json()) as { unit_type: { status: string } }).unit_type.status).toBe('inactive')

    const agent = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(agent.status).toBe(403)
  })
})

// ============================================================================
// Admin API — seasons (US-A60) & quantity block-outs (US-A61, D11)
// ============================================================================

describe('admin seasons & blockouts', () => {
  it('Sc5 — season persists; overlapping season → 409', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId })
    const base = `http://api.local/api/services/${serviceId}/unit-types/${typeId}/seasons`

    const ok = await SELF.fetch(base, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'Navidad', start_date: '2026-12-20', end_date: '2026-12-31', nightly_rate: 200000 }),
    })
    expect(ok.status).toBe(201)

    const overlap = await SELF.fetch(base, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'Otra', start_date: '2026-12-25', end_date: '2027-01-05', nightly_rate: 180000 }),
    })
    expect(overlap.status).toBe(409)
    const body = (await overlap.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SEASON_OVERLAP')
  })

  it('Sc8 — blockout add (with quantity) / list / delete; quantity > inventory → 400', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 3 })
    const base = `http://api.local/api/services/${serviceId}/unit-types/${typeId}/blockouts`

    const add = await SELF.fetch(base, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        start_date: '2026-07-10', end_date: '2026-07-12', quantity: 2, reason: 'Mantenimiento',
      }),
    })
    expect(add.status).toBe(201)
    const created = ((await add.json()) as { blockout: { id: string; quantity: number } }).blockout
    expect(created.quantity).toBe(2)

    // A single blockout can't exceed the pool.
    const tooMany = await SELF.fetch(base, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ start_date: '2026-07-10', end_date: '2026-07-12', quantity: 4 }),
    })
    expect(tooMany.status).toBe(400)

    const list = await SELF.fetch(base, { headers: auth(ADMIN_EMAIL) })
    expect(((await list.json()) as { blockouts: unknown[] }).blockouts).toHaveLength(1)

    const del = await SELF.fetch(`${base}/${created.id}`, {
      method: 'DELETE',
      headers: auth(ADMIN_EMAIL),
    })
    expect(del.status).toBe(200)
    const list2 = await SELF.fetch(base, { headers: auth(ADMIN_EMAIL) })
    expect(((await list2.json()) as { blockouts: unknown[] }).blockouts).toHaveLength(0)
  })
})

// ============================================================================
// POS availability reads (US-AG36 / AG37)
// ============================================================================

describe('POS lodging availability', () => {
  it('Sc13 — range-first returns available types with correct totals and min_remaining', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    await seedUnitType({
      organizationId: orgId, serviceId, name: 'Estándar', inventoryCount: 3, baseRate: 100000,
    })
    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      unit_types: { name: string; nights: number; total: number; min_remaining: number; quantity: number }[]
    }
    expect(body.unit_types).toHaveLength(1)
    expect(body.unit_types[0].nights).toBe(3)
    expect(body.unit_types[0].total).toBe(300000)
    expect(body.unit_types[0].min_remaining).toBe(3)
    expect(body.unit_types[0].quantity).toBe(1)
  })

  it('quantity=2 doubles the room total and filters types with less inventory', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    await seedUnitType({
      organizationId: orgId, serviceId, name: 'Doble', inventoryCount: 2, baseRate: 100000,
    })
    await seedUnitType({
      organizationId: orgId, serviceId, name: 'Única', inventoryCount: 1, baseRate: 80000,
    })
    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=4&quantity=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    const body = (await res.json()) as { unit_types: { name: string; total: number }[] }
    // The count-1 type can't host 2 rooms → omitted.
    expect(body.unit_types).toHaveLength(1)
    expect(body.unit_types[0].name).toBe('Doble')
    expect(body.unit_types[0].total).toBe(2 * 100000 * 3)
  })

  it('Sc8 — a full-pool blockout hides the type; a partial one only reduces it', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 2 })
    await seedBlockout(orgId, serviceId, typeId, '2026-07-11', '2026-07-12', 1)

    // 1 of 2 rooms blocked → a 1-room stay still fits.
    const partial = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(((await partial.json()) as { unit_types: unknown[] }).unit_types).toHaveLength(1)

    // Block the second room too (overlapping blockouts SUM) → nothing left.
    await seedBlockout(orgId, serviceId, typeId, '2026-07-11', '2026-07-12', 1)
    const full = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(((await full.json()) as { unit_types: unknown[] }).unit_types).toHaveLength(0)
  })

  it('Sc9 — a type below its min_nights is hidden', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    await seedUnitType({ organizationId: orgId, serviceId, minNights: 3 })
    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-11&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(((await res.json()) as { unit_types: unknown[] }).unit_types).toHaveLength(0)
  })

  it('Sc10 — a reservation consuming the pool blocks an overlapping range but not the checkout day', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 1 })
    await seedReservation(orgId, serviceId, typeId, '2026-07-08', '2026-07-12')

    const overlap = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(((await overlap.json()) as { unit_types: unknown[] }).unit_types).toHaveLength(0)

    const turnover = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-12&check_out=2026-07-14&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(((await turnover.json()) as { unit_types: unknown[] }).unit_types).toHaveLength(1)
  })

  it('invalid range or quantity → 400', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const range = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-13&check_out=2026-07-10&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(range.status).toBe(400)
    const qty = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=2&quantity=0`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(qty.status).toBe(400)
  })

  it('AG37 — the type calendar returns REMAINING per day', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({
      organizationId: orgId, serviceId, inventoryCount: 3, baseRate: 100000,
    })
    await seedBlockout(orgId, serviceId, typeId, '2026-07-11', '2026-07-12', 2)
    await seedReservation(orgId, serviceId, typeId, '2026-07-13', '2026-07-15')

    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/unit-types/${typeId}/calendar?from=2026-07-10&to=2026-07-15`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      inventory_count: number
      days: { date: string; remaining: number; rate: number }[]
    }
    expect(body.inventory_count).toBe(3)
    const byDate = Object.fromEntries(body.days.map((d) => [d.date, d.remaining]))
    expect(byDate['2026-07-10']).toBe(3)
    expect(byDate['2026-07-11']).toBe(1) // 2 blocked
    expect(byDate['2026-07-12']).toBe(3)
    expect(byDate['2026-07-13']).toBe(2) // 1 reserved
    expect(byDate['2026-07-14']).toBe(2)
    expect(byDate['2026-07-15']).toBe(3) // checkout day is free
  })
})

// ============================================================================
// POS catalog — FLATTENED (spec §4.3, D14)
// ============================================================================

interface CatalogItem {
  item_type: 'tour' | 'unit_type'
  id: string
  name: string
  category: string | null
  has_availability: boolean
  nightly_rate?: number
  max_capacity?: number
  remaining?: number
  service_id?: string
  property_name?: string
}

describe('POS catalog (flattened)', () => {
  it('D14 — one card per active unit type; the parent lodging service is not a card', async () => {
    const { serviceId } = await seedLodgingService(orgId, 'Hotel Centro')
    const { typeId: t1 } = await seedUnitType({
      organizationId: orgId, serviceId, name: 'Estándar', inventoryCount: 5, baseRate: 120000,
    })
    const { typeId: t2 } = await seedUnitType({
      organizationId: orgId, serviceId, name: 'Suite', inventoryCount: 2, baseRate: 250000,
    })
    await seedUnitType({
      organizationId: orgId, serviceId, name: 'Vieja', status: 'inactive',
    })
    const tour = await seedTourService(orgId)

    const res = await SELF.fetch('http://api.local/api/pos/services', {
      headers: auth(ADMIN_EMAIL),
    })
    const items = ((await res.json()) as { services: CatalogItem[] }).services

    const ids = items.map((i) => i.id)
    expect(ids).toContain(t1)
    expect(ids).toContain(t2)
    expect(ids).toContain(tour.serviceId)
    expect(ids).not.toContain(serviceId) // the parent property is never a card
    expect(ids).toHaveLength(3) // the inactive type contributes nothing

    const std = items.find((i) => i.id === t1)!
    expect(std.item_type).toBe('unit_type')
    expect(std.category).toBe('lodging')
    expect(std.nightly_rate).toBe(120000) // exact price, not "Desde $X"
    expect(std.max_capacity).toBe(4) // per-room guest cap (D12 — caps the sheet's stepper)
    expect(std.property_name).toBe('Hotel Centro')
    expect(std.service_id).toBe(serviceId)
    expect(std.has_availability).toBe(true)
    expect(std.remaining).toBe(5)

    const tourCard = items.find((i) => i.id === tour.serviceId)!
    expect(tourCard.item_type).toBe('tour')
  })

  it('remaining reflects the per-night MIN over the window ("Quedan N")', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 3 })
    // 2 rooms reserved on one night inside the window → min remaining = 1.
    await seedReservation(orgId, serviceId, typeId, '2026-07-11', '2026-07-12', 'active', 2)

    const res = await SELF.fetch(
      'http://api.local/api/pos/services?from=2026-07-10&to=2026-07-12',
      { headers: auth(ADMIN_EMAIL) },
    )
    const items = ((await res.json()) as { services: CatalogItem[] }).services
    const card = items.find((i) => i.id === typeId)!
    expect(card.remaining).toBe(1)
    expect(card.has_availability).toBe(true)
  })

  it('availability/days lights lodging days from real counts (dots)', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 1 })
    // The single room is taken 07-20 → 07-22 (nights 20 & 21).
    await seedReservation(orgId, serviceId, typeId, '2026-07-20', '2026-07-22')

    const res = await SELF.fetch(
      'http://api.local/api/pos/availability/days?month=2026-07&today=2026-07-15&categories=lodging',
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(res.status).toBe(200)
    const days = ((await res.json()) as { days: string[] }).days
    expect(days).toContain('2026-07-15')
    expect(days).toContain('2026-07-19')
    expect(days).not.toContain('2026-07-20')
    expect(days).not.toContain('2026-07-21')
    expect(days).toContain('2026-07-22') // checkout day frees the night
  })
})

// ============================================================================
// POS sale path — stay lines on confirmSale (spec §4.4, D10/D12/D13)
// ============================================================================

interface SaleResponse {
  folio: {
    id: string
    status: string
    total: number
    lines: {
      line_type: string
      unit_type_id: string | null
      check_in: string | null
      check_out: string | null
      guests: number | null
      nights: number | null
      quantity: number
      line_total: number
      qr_token: string | null
    }[]
  }
}

const sellStay = (
  typeId: string,
  checkIn: string,
  checkOut: string,
  guests: number,
  quantity = 1,
  extra: Record<string, unknown> = {},
) =>
  SELF.fetch('http://api.local/api/pos/folios', {
    method: 'POST',
    headers: jsonAuth(ADMIN_EMAIL),
    body: JSON.stringify({
      customer_name: 'Cliente',
      customer_phone: '5512345678',
      customer_email: 'cliente@example.com',
      lines: [{ unit_type_id: typeId, check_in: checkIn, check_out: checkOut, guests, quantity }],
      ...extra,
    }),
  })

const reservationsForFolio = async (folioId: string) =>
  (
    await env.DB.prepare(
      'SELECT status, quantity, check_in, check_out FROM accommodation_reservations WHERE folio_id = ?',
    )
      .bind(folioId)
      .all<{ status: string; quantity: number; check_in: string; check_out: string }>()
  ).results

// The commission snapshot stored on the folio line (the waterfall's resolved result).
const commissionForFolio = async (folioId: string) =>
  (
    await env.DB.prepare(
      'SELECT commission_type, commission_value, quantity FROM folio_lines WHERE folio_id = ?',
    )
      .bind(folioId)
      .all<{ commission_type: string; commission_value: number; quantity: number }>()
  ).results

const sellStayFolioId = async (
  typeId: string,
  checkIn: string,
  checkOut: string,
  guests = 2,
  quantity = 1,
) => ((await (await sellStay(typeId, checkIn, checkOut, guests, quantity)).json()) as SaleResponse).folio.id

describe('POS lodging sale path', () => {
  it('Sc16 — a paid stay sale creates an active reservation + a stay folio line', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, baseRate: 100000 })

    const res = await sellStay(typeId, '2026-07-10', '2026-07-13', 2)
    expect(res.status).toBe(201)
    const body = (await res.json()) as SaleResponse
    expect(body.folio.status).toBe('paid')
    expect(body.folio.total).toBe(300000)
    const line = body.folio.lines[0]
    expect(line.line_type).toBe('stay')
    expect(line.unit_type_id).toBe(typeId)
    expect(line.nights).toBe(3)
    expect(line.quantity).toBe(1)
    expect(line.line_total).toBe(300000)
    expect(line.qr_token).toBeNull() // a stay has no per-line QR

    const reservations = await reservationsForFolio(body.folio.id)
    expect(reservations).toHaveLength(1)
    expect(reservations[0].status).toBe('active')
    expect(reservations[0].quantity).toBe(1)
  })

  it('D12 — a multi-room sale reserves the quantity and prices the even split', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({
      organizationId: orgId, serviceId, inventoryCount: 3, baseRate: 100000,
      extraPersonFee: 30000, baseOccupancy: 2, maxCapacity: 4,
    })

    // 2 rooms × 3 nights, 5 guests → split [3,2]: one extra guest → +30000/night.
    const res = await sellStay(typeId, '2026-07-10', '2026-07-13', 5, 2)
    expect(res.status).toBe(201)
    const body = (await res.json()) as SaleResponse
    expect(body.folio.total).toBe(2 * 100000 * 3 + 30000 * 3)
    expect(body.folio.lines[0].quantity).toBe(2)
    expect((await reservationsForFolio(body.folio.id))[0].quantity).toBe(2)

    // Only 1 room left → a 2-room request fails, a 1-room request succeeds.
    expect((await sellStay(typeId, '2026-07-11', '2026-07-12', 2, 2)).status).toBe(409)
    expect((await sellStay(typeId, '2026-07-11', '2026-07-12', 2, 1)).status).toBe(201)
  })

  it('a stay folio reads back with its stay fields (POS + admin detail)', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, baseRate: 100000 })
    const folioId = await sellStayFolioId(typeId, '2026-07-10', '2026-07-13', 2)

    // POS receipt read (US-AG08).
    const pos = await SELF.fetch(`http://api.local/api/pos/folios/${folioId}`, {
      headers: auth(ADMIN_EMAIL),
    })
    const posLine = ((await pos.json()) as SaleResponse).folio.lines[0]
    expect(posLine.line_type).toBe('stay')
    expect(posLine.check_in).toBe('2026-07-10')
    expect(posLine.check_out).toBe('2026-07-13')
    expect(posLine.nights).toBe(3)
    expect(posLine.unit_type_id).toBe(typeId)

    // Admin folio detail (US-A21).
    const admin = await SELF.fetch(`http://api.local/api/folios/${folioId}`, {
      headers: auth(ADMIN_EMAIL),
    })
    const adminLine = ((await admin.json()) as {
      folio: { lines: { line_type: string; nights: number; unit_type_id: string }[] }
    }).folio.lines[0]
    expect(adminLine.line_type).toBe('stay')
    expect(adminLine.nights).toBe(3)
    expect(adminLine.unit_type_id).toBe(typeId)
  })

  it('Sc15 (last room) — the count guard rejects an oversell but allows checkout-day turnover', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 1 })

    expect((await sellStay(typeId, '2026-07-10', '2026-07-13', 2)).status).toBe(201)

    const overlap = await sellStay(typeId, '2026-07-12', '2026-07-14', 2)
    expect(overlap.status).toBe(409)
    expect(((await overlap.json()) as { error: { code: string } }).error.code).toBe(
      'INSUFFICIENT_INVENTORY',
    )

    // The oversell rollback must not strand a folio (it is compensated/deleted).
    const folioCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM folios').first<{ n: number }>()
    expect(folioCount!.n).toBe(1)

    // Turnover — starts on the prior stay's checkout day → allowed.
    expect((await sellStay(typeId, '2026-07-13', '2026-07-15', 2)).status).toBe(201)
  })

  it('Sc14 — the FALSE-409 shape: two non-overlapping stays do not block a spanning request', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 2 })

    // Room A: Mon–Wed. Room B: Thu–Sat. They never overlap EACH OTHER, so per-night occupancy
    // never exceeds 1 of 2 — a whole-week 1-room request MUST succeed. (The naive
    // SUM-over-overlapping-reservations guard would count 2 and wrongly reject it.)
    expect((await sellStay(typeId, '2026-07-13', '2026-07-15', 2)).status).toBe(201)
    expect((await sellStay(typeId, '2026-07-16', '2026-07-18', 2)).status).toBe(201)

    const spanning = await sellStay(typeId, '2026-07-13', '2026-07-18', 2)
    expect(spanning.status).toBe(201)

    // Now every night in 13–18 has ≥ 1 room taken and 14/16 have 2 → nothing left mid-week.
    expect((await sellStay(typeId, '2026-07-14', '2026-07-15', 2)).status).toBe(409)
  })

  it('Sc9 — a sale below min_nights → 400 MIN_STAY_NOT_MET', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, minNights: 3 })
    const res = await sellStay(typeId, '2026-07-10', '2026-07-11', 2)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MIN_STAY_NOT_MET')
  })

  it('Sc7 — guests beyond max_capacity × quantity → 400; more rooms fixes it', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({
      organizationId: orgId, serviceId, inventoryCount: 2, maxCapacity: 4,
    })
    expect((await sellStay(typeId, '2026-07-10', '2026-07-12', 5, 1)).status).toBe(400)
    expect((await sellStay(typeId, '2026-07-10', '2026-07-12', 5, 2)).status).toBe(201)
  })

  it('quantity above the type inventory → 400', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 2 })
    expect((await sellStay(typeId, '2026-07-10', '2026-07-12', 2, 3)).status).toBe(400)
  })

  it('Sc15 — a deposit booking holds the quantity; cancelling frees it for resale', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({
      organizationId: orgId, serviceId, inventoryCount: 1, baseRate: 100000,
    })

    const booking = await sellStay(typeId, '2026-07-10', '2026-07-13', 2, 1, {
      down_payment: 150000,
      customer_name: 'Cliente Test',
      customer_phone: '+525555555555',
    })
    expect(booking.status).toBe(201)
    const folio = ((await booking.json()) as SaleResponse).folio
    expect(folio.status).toBe('booking')
    expect((await reservationsForFolio(folio.id))[0].status).toBe('active')

    // The held quantity blocks a competing sale.
    expect((await sellStay(typeId, '2026-07-11', '2026-07-12', 2)).status).toBe(409)

    // Cancel the booking → reservation released.
    const cancel = await SELF.fetch(`http://api.local/api/pos/folios/${folio.id}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'Cliente canceló' }),
    })
    expect(cancel.status).toBe(200)
    expect((await reservationsForFolio(folio.id))[0].status).toBe('cancelled')

    // Same range is now sellable again.
    expect((await sellStay(typeId, '2026-07-10', '2026-07-13', 2)).status).toBe(201)
  })

  it('Sc15 — reactivating a cancelled stay booking re-claims its quantity', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 1 })

    const booking = await sellStay(typeId, '2026-07-10', '2026-07-13', 2, 1, {
      down_payment: 150000,
      customer_name: 'Cliente Test',
      customer_phone: '+525555555555',
    })
    const folioId = ((await booking.json()) as SaleResponse).folio.id
    await SELF.fetch(`http://api.local/api/pos/folios/${folioId}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'temp' }),
    })
    expect((await reservationsForFolio(folioId))[0].status).toBe('cancelled')

    const reactivate = await SELF.fetch(`http://api.local/api/pos/folios/${folioId}/reactivate`, {
      method: 'POST',
      headers: auth(ADMIN_EMAIL),
    })
    expect(reactivate.status).toBe(200)
    expect((await reservationsForFolio(folioId))[0].status).toBe('active')
  })

  it('Sc15 — reactivation fails if the inventory was consumed while the booking was cancelled', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, inventoryCount: 1 })

    const booking = await sellStay(typeId, '2026-07-10', '2026-07-13', 2, 1, {
      down_payment: 150000,
      customer_name: 'Cliente Test',
      customer_phone: '+525555555555',
    })
    const folioId = ((await booking.json()) as SaleResponse).folio.id
    await SELF.fetch(`http://api.local/api/pos/folios/${folioId}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'temp' }),
    })

    // A competing sale grabs the freed room.
    expect((await sellStay(typeId, '2026-07-11', '2026-07-12', 2)).status).toBe(201)

    const reactivate = await SELF.fetch(`http://api.local/api/pos/folios/${folioId}/reactivate`, {
      method: 'POST',
      headers: auth(ADMIN_EMAIL),
    })
    expect(reactivate.status).toBe(409)
    expect(((await reactivate.json()) as { error: { code: string } }).error.code).toBe(
      'INSUFFICIENT_INVENTORY',
    )
    // The reservation stays cancelled (reactivation rolled back).
    expect((await reservationsForFolio(folioId))[0].status).toBe('cancelled')
  })

  it('settling a stay booking pays it without stamping a QR on the stay line', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, baseRate: 100000 })
    const booking = await sellStay(typeId, '2026-07-10', '2026-07-13', 2, 1, {
      down_payment: 150000,
      customer_name: 'Cliente Test',
      customer_phone: '+525555555555',
    })
    const folioId = ((await booking.json()) as SaleResponse).folio.id

    const settle = await SELF.fetch(`http://api.local/api/pos/folios/${folioId}/settle`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({}),
    })
    expect(settle.status).toBe(200)

    const detail = await SELF.fetch(`http://api.local/api/pos/folios/${folioId}`, {
      headers: auth(ADMIN_EMAIL),
    })
    const folio = ((await detail.json()) as SaleResponse).folio
    expect(folio.status).toBe('paid')
    expect(folio.lines[0].line_type).toBe('stay')
    expect(folio.lines[0].qr_token).toBeNull() // a stay has no scannable QR
    // The reservation stays active through settlement.
    expect((await reservationsForFolio(folioId))[0].status).toBe('active')
  })

  it('Sc12 — admin cancel of a paid stay opens a structured refund (free window vs penalty)', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({
      organizationId: orgId, serviceId, inventoryCount: 2, baseRate: 100000,
    })
    // Org policy: free cancellation ≥ 7 days out, else a 50% penalty.
    await env.DB.prepare(
      'UPDATE organizations SET lodging_free_cancel_days = 7, lodging_cancel_penalty_pct = 50 WHERE id = ?',
    )
      .bind(orgId)
      .run()

    // Frozen clock is 2026-06-14. Check-in 2026-07-10 is 26 days out → inside the free window.
    const free = await sellStay(typeId, '2026-07-10', '2026-07-13', 2)
    const freeId = ((await free.json()) as SaleResponse).folio.id
    const cancelFree = await SELF.fetch(`http://api.local/api/folios/${freeId}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'cambio de planes' }),
    })
    expect(cancelFree.status).toBe(200)
    const freeRow = await env.DB.prepare(
      'SELECT refund_status, refund_amount FROM folios WHERE id = ?',
    )
      .bind(freeId)
      .first<{ refund_status: string; refund_amount: number }>()
    expect(freeRow!.refund_status).toBe('pending')
    expect(freeRow!.refund_amount).toBe(300000) // full refund inside the free window
    // The reservation is released on cancel.
    expect((await reservationsForFolio(freeId))[0].status).toBe('cancelled')

    // Check-in 2026-06-16 is 2 days out → inside the penalty window (50% withheld).
    const late = await sellStay(typeId, '2026-06-16', '2026-06-18', 2)
    const lateId = ((await late.json()) as SaleResponse).folio.id
    await SELF.fetch(`http://api.local/api/folios/${lateId}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'no show' }),
    })
    const lateRow = await env.DB.prepare('SELECT refund_amount FROM folios WHERE id = ?')
      .bind(lateId)
      .first<{ refund_amount: number }>()
    expect(lateRow!.refund_amount).toBe(100000) // 200000 × (100−50)%
  })
})

// ============================================================================
// Commission waterfall — per-type override ?? service base (US-A12, D13)
// ============================================================================

describe('lodging commission waterfall', () => {
  const typeInput = (extra: Record<string, unknown> = {}) => ({
    name: 'Suite', beds: 1, base_occupancy: 2, max_capacity: 3, base_rate: 120000, ...extra,
  })

  it('a type with no override inherits the service base commission', async () => {
    const { serviceId } = await seedLodgingService(orgId, 'Hotel', { type: 'percent', value: 1000 })
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, baseRate: 100000 })
    const folioId = await sellStayFolioId(typeId, '2026-07-10', '2026-07-12')
    const [c] = await commissionForFolio(folioId)
    expect(c.commission_type).toBe('percent')
    expect(c.commission_value).toBe(1000) // inherited from the service
  })

  it('a type percent override beats the service base', async () => {
    const { serviceId } = await seedLodgingService(orgId, 'Hotel', { type: 'percent', value: 1000 })
    const { typeId } = await seedUnitType({
      organizationId: orgId, serviceId, baseRate: 100000,
      commissionType: 'percent', commissionValue: 1500,
    })
    const [c] = await commissionForFolio(await sellStayFolioId(typeId, '2026-07-10', '2026-07-12'))
    expect(c.commission_type).toBe('percent')
    expect(c.commission_value).toBe(1500)
  })

  it('D13 — a fixed override counts per ROOM-stay (value × quantity)', async () => {
    const { serviceId } = await seedLodgingService(orgId, 'Hotel', { type: 'percent', value: 1000 })
    const { typeId } = await seedUnitType({
      organizationId: orgId, serviceId, inventoryCount: 3, baseRate: 100000,
      commissionType: 'fixed', commissionValue: 50000,
    })
    const folioId = await sellStayFolioId(typeId, '2026-07-10', '2026-07-12', 4, 2)
    const [c] = await commissionForFolio(folioId)
    expect(c.commission_type).toBe('fixed')
    expect(c.commission_value).toBe(50000)
    expect(c.quantity).toBe(2) // fixed commission accrues value × quantity at settlement

    // The paid folio's commission snapshot: 50000 × 2 rooms.
    const folioRow = await env.DB.prepare('SELECT commission_amount FROM folios WHERE id = ?')
      .bind(folioId)
      .first<{ commission_amount: number }>()
    expect(folioRow!.commission_amount).toBe(100000)
  })

  it('admin can create a type with a percent override, and omitting it inherits (null)', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const withOverride = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST', headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify(typeInput({ commission_type: 'percent', commission_value: 1500 })),
    })
    expect(withOverride.status).toBe(201)
    expect((await withOverride.json() as {
      unit_type: { commission_type: string | null; commission_value: number | null }
    }).unit_type).toMatchObject({ commission_type: 'percent', commission_value: 1500 })

    const inherit = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST', headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify(typeInput({ name: 'Cabaña' })),
    })
    expect(inherit.status).toBe(201)
    expect((await inherit.json() as {
      unit_type: { commission_type: string | null }
    }).unit_type.commission_type).toBeNull()
  })

  it('rejects a type override with a type but no value (400)', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST', headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify(typeInput({ commission_type: 'fixed' })),
    })
    expect(res.status).toBe(400)
  })
})

// ============================================================================
// Multitenancy isolation — B1 / B3 / B4 (seedTwoOrgs)
// ============================================================================

describe('multitenancy', () => {
  it('B1 — injected organizationId is ignored on unit-type create', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { serviceId } = await seedLodgingService(orgA.organizationId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      method: 'POST',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        organizationId: orgB.organizationId,
        name: 'X',
        beds: 1,
        base_occupancy: 1,
        max_capacity: 2,
        base_rate: 1000,
      }),
    })
    expect(res.status).toBe(201)
    const typeId = ((await res.json()) as { unit_type: { id: string } }).unit_type.id
    const row = await env.DB.prepare(
      'SELECT organization_id FROM accommodation_unit_types WHERE id = ?',
    )
      .bind(typeId)
      .first<{ organization_id: string }>()
    expect(row!.organization_id).toBe(orgA.organizationId)
  })

  it('B3 — cross-org unit-type list / availability / calendar / stay line → 404', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { serviceId } = await seedLodgingService(orgA.organizationId)
    const { typeId } = await seedUnitType({ organizationId: orgA.organizationId, serviceId })

    // Org B admin lists unit types under org A's service → 404 (service not in their org).
    const list = await SELF.fetch(`http://api.local/api/services/${serviceId}/unit-types`, {
      headers: auth(orgB.adminEmail),
    })
    expect(list.status).toBe(404)

    // Org B admin queries availability for org A's lodging service → 404.
    const avail = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-12&guests=2`,
      { headers: auth(orgB.adminEmail) },
    )
    expect(avail.status).toBe(404)

    // Org B admin opens org A's type calendar → 404.
    const cal = await SELF.fetch(
      `http://api.local/api/pos/lodging/unit-types/${typeId}/calendar?from=2026-07-10&to=2026-07-12`,
      { headers: auth(orgB.adminEmail) },
    )
    expect(cal.status).toBe(404)

    // Org B admin sells a stay against org A's type → 404 (never a write).
    const sale = await SELF.fetch('http://api.local/api/pos/folios', {
      method: 'POST',
      headers: jsonAuth(orgB.adminEmail),
      body: JSON.stringify({
        customer_name: 'Cliente Test',
        customer_phone: '5512345678',
        customer_email: 'x@example.com',
        lines: [{ unit_type_id: typeId, check_in: '2026-07-10', check_out: '2026-07-12', guests: 2, quantity: 1 }],
      }),
    })
    expect(sale.status).toBe(404)
  })

  it('B4 — the flattened catalog is scoped to the caller org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const svcA = await seedLodgingService(orgA.organizationId)
    const typeA = await seedUnitType({ organizationId: orgA.organizationId, serviceId: svcA.serviceId })
    const svcB = await seedLodgingService(orgB.organizationId)
    const typeB = await seedUnitType({ organizationId: orgB.organizationId, serviceId: svcB.serviceId })

    // Org B catalog shows only org B's type cards.
    const res = await SELF.fetch('http://api.local/api/pos/services', {
      headers: auth(orgB.adminEmail),
    })
    const ids = ((await res.json()) as { services: { id: string }[] }).services.map((s) => s.id)
    expect(ids).toContain(typeB.typeId)
    expect(ids).not.toContain(typeA.typeId)
  })
})

// Season pricing rides through the POS quote (kept from v1 — verifies seasonsByType wiring).
describe('seasonal rate through the POS quote', () => {
  it('a season overlapping the stay reprices those nights', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { typeId } = await seedUnitType({ organizationId: orgId, serviceId, baseRate: 100000 })
    await seedSeason(orgId, serviceId, typeId, '2026-07-11', '2026-07-20', 200000)

    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    const body = (await res.json()) as { unit_types: { total: number }[] }
    // night 10 base 100000 + nights 11 & 12 season 200000.
    expect(body.unit_types[0].total).toBe(100000 + 200000 + 200000)
  })
})
