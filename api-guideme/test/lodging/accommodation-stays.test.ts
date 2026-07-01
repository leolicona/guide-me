import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearAffiliateDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import {
  quoteStay,
  checkUnitAvailable,
  nightsBetween,
  rangesOverlap,
  type UnitRateInfo,
} from '../../src/utils/lodging'

// Accommodation Stays — lodging units, nightly pricing, date-range availability.
// Spec: docs/lodging/accommodation-stays.spec.md. Covers the engine, the admin units/seasons/
// blockouts API (US-A59–A62), the POS availability reads (US-AG36/37), the catalog lodging
// branch, and multitenancy isolation (B1/B3/B4 via seedTwoOrgs).

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

interface SeedUnitOpts {
  organizationId: string
  serviceId: string
  name?: string
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

const seedUnit = async (o: SeedUnitOpts): Promise<{ unitId: string }> => {
  const unitId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO accommodation_units
       (id, organization_id, service_id, name, unit_type, beds, base_occupancy, max_capacity,
        base_rate, weekend_rate, extra_person_fee, min_nights, checkin_time, checkout_time,
        amenities, commission_type, commission_value, status)
     VALUES (?, ?, ?, ?, 'cabin', 2, ?, ?, ?, ?, ?, ?, '15:00', '11:00', ?, ?, ?, ?)`,
  )
    .bind(
      unitId,
      o.organizationId,
      o.serviceId,
      o.name ?? 'Cabaña 1',
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
  return { unitId }
}

const seedSeason = async (
  organizationId: string,
  serviceId: string,
  unitId: string,
  startDate: string,
  endDate: string,
  nightlyRate: number,
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO accommodation_seasons
       (id, organization_id, service_id, unit_id, name, start_date, end_date, nightly_rate, status)
     VALUES (?, ?, ?, ?, 'Temporada', ?, ?, ?, 'active')`,
  )
    .bind(crypto.randomUUID(), organizationId, serviceId, unitId, startDate, endDate, nightlyRate)
    .run()
}

const seedBlockout = async (
  organizationId: string,
  serviceId: string,
  unitId: string,
  startDate: string,
  endDate: string,
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO accommodation_blockouts
       (id, organization_id, service_id, unit_id, start_date, end_date, reason)
     VALUES (?, ?, ?, ?, ?, ?, null)`,
  )
    .bind(crypto.randomUUID(), organizationId, serviceId, unitId, startDate, endDate)
    .run()
}

const seedReservation = async (
  organizationId: string,
  serviceId: string,
  unitId: string,
  checkIn: string,
  checkOut: string,
  status: 'active' | 'cancelled' = 'active',
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
       (id, organization_id, service_id, unit_id, folio_id, check_in, check_out, guests, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?)`,
  )
    .bind(crypto.randomUUID(), organizationId, serviceId, unitId, folioId, checkIn, checkOut, status)
    .run()
}

let orgId: string

beforeEach(async () => {
  // Clear the accommodation tables FIRST — they reference services/folios, which clearAffiliateDb
  // deletes (FK order). folio_lines now carries unit_id → accommodation_units, so folio lines must
  // be cleared before the units. Order: reservations → folio line rows → seasons/blockouts → units.
  for (const t of [
    'accommodation_reservations',
    'folio_line_extras',
    'folio_lines',
    'accommodation_seasons',
    'accommodation_blockouts',
    'accommodation_units',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
  await clearAffiliateDb()
  const seeded = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  orgId = seeded.organizationId
  await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: orgId })
})

// ============================================================================
// Engine unit tests (pure — spec §3, scenarios 6/7/10)
// ============================================================================

describe('lodging engine', () => {
  const unit: UnitRateInfo = {
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
    const q = quoteStay(unit, '2026-12-19', '2026-12-22', 2, seasons, [5, 6])
    // night 19 (Sat, weekend) 140000 + night 20 (season) 200000 + night 21 (season) 200000
    expect(q.nights).toBe(3)
    expect(q.total).toBe(140000 + 200000 + 200000)
  })

  it('Sc7 — extra-person surcharge per night', () => {
    // 3 nights, 3 guests (1 over base occupancy of 2) → +30000 × 3 nights. All weekdays (base).
    const q = quoteStay(unit, '2026-07-13', '2026-07-16', 3, [], [5, 6])
    expect(q.total).toBe(100000 * 3 + 30000 * 3)
  })

  it('Sc10 — checkout-day reuse (half-open turnover)', () => {
    // A stay …→07-12 and a new stay 07-12→07-14 do NOT overlap.
    expect(rangesOverlap('2026-07-10', '2026-07-12', '2026-07-12', '2026-07-14')).toBe(false)
    expect(rangesOverlap('2026-07-10', '2026-07-13', '2026-07-12', '2026-07-14')).toBe(true)
  })

  it('nightsBetween counts nights, not days', () => {
    expect(nightsBetween('2026-07-10', '2026-07-13')).toBe(3)
  })

  it('checkUnitAvailable enforces min-stay, capacity, blockout, overlap', () => {
    const u = { status: 'active', maxCapacity: 4, minNights: 2 }
    expect(checkUnitAvailable(u, '2026-07-10', '2026-07-11', 2, [], [])).toBe('MIN_STAY_NOT_MET')
    expect(checkUnitAvailable(u, '2026-07-10', '2026-07-13', 5, [], [])).toBe('OVER_CAPACITY')
    expect(
      checkUnitAvailable(u, '2026-07-10', '2026-07-13', 2, [{ startDate: '2026-07-11', endDate: '2026-07-12' }], []),
    ).toBe('BLOCKED')
    expect(
      checkUnitAvailable(u, '2026-07-10', '2026-07-13', 2, [], [{ checkIn: '2026-07-12', checkOut: '2026-07-14' }]),
    ).toBe('OVERLAP')
    expect(checkUnitAvailable(u, '2026-07-10', '2026-07-13', 2, [], [])).toBeNull()
  })
})

// ============================================================================
// Admin API — units (US-A59)
// ============================================================================

describe('admin units', () => {
  it('Sc1 — creates a unit', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'Cabaña 1',
        beds: 2,
        base_occupancy: 2,
        max_capacity: 4,
        base_rate: 150000,
        amenities: ['wifi', 'parking'],
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { unit: { id: string; amenities: string[]; status: string } }
    expect(body.unit.amenities).toEqual(['wifi', 'parking'])
    expect(body.unit.status).toBe('active')
  })

  it('Sc2 — rejects max_capacity < base_occupancy', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'X', beds: 1, base_occupancy: 4, max_capacity: 2, base_rate: 1000 }),
    })
    expect(res.status).toBe(400)
  })

  it('Sc3 — rejects a unit on a non-lodging service', async () => {
    const { serviceId } = await seedTourService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ name: 'X', beds: 1, base_occupancy: 1, max_capacity: 2, base_rate: 1000 }),
    })
    expect(res.status).toBe(400)
  })

  it('Sc11 — rejects an unknown amenity key', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'X',
        beds: 1,
        base_occupancy: 1,
        max_capacity: 2,
        base_rate: 1000,
        amenities: ['spa'],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('Sc4 — deactivate / reactivate, agent forbidden', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId })

    const off = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/units/${unitId}/deactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    expect(off.status).toBe(200)
    expect(((await off.json()) as { unit: { status: string } }).unit.status).toBe('inactive')

    const agent = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(agent.status).toBe(403)
  })
})

// ============================================================================
// Admin API — seasons (US-A60) & blockouts (US-A61)
// ============================================================================

describe('admin seasons & blockouts', () => {
  it('Sc5 — season persists; overlapping season → 409', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId })
    const base = `http://api.local/api/services/${serviceId}/units/${unitId}/seasons`

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

  it('Sc8 — blockout add / list / delete', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId })
    const base = `http://api.local/api/services/${serviceId}/units/${unitId}/blockouts`

    const add = await SELF.fetch(base, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ start_date: '2026-07-10', end_date: '2026-07-12', reason: 'Mantenimiento' }),
    })
    expect(add.status).toBe(201)
    const blockoutId = ((await add.json()) as { blockout: { id: string } }).blockout.id

    const list = await SELF.fetch(base, { headers: auth(ADMIN_EMAIL) })
    expect(((await list.json()) as { blockouts: unknown[] }).blockouts).toHaveLength(1)

    const del = await SELF.fetch(`${base}/${blockoutId}`, {
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
  it('Sc13 — range-first returns free units with correct totals', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    await seedUnit({ organizationId: orgId, serviceId, name: 'Cabaña 1', baseRate: 100000 })
    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { units: { name: string; nights: number; total: number }[] }
    expect(body.units).toHaveLength(1)
    expect(body.units[0].nights).toBe(3)
    expect(body.units[0].total).toBe(300000)
  })

  it('Sc8 — a blockout hides the unit from availability', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId })
    await seedBlockout(orgId, serviceId, unitId, '2026-07-11', '2026-07-12')
    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(((await res.json()) as { units: unknown[] }).units).toHaveLength(0)
  })

  it('Sc9 — a unit below its min_nights is hidden', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    await seedUnit({ organizationId: orgId, serviceId, minNights: 3 })
    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-11&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(((await res.json()) as { units: unknown[] }).units).toHaveLength(0)
  })

  it('Sc10 — an active reservation blocks an overlapping range but not the checkout day', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId })
    await seedReservation(orgId, serviceId, unitId, '2026-07-08', '2026-07-12')

    const overlap = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-13&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(((await overlap.json()) as { units: unknown[] }).units).toHaveLength(0)

    const turnover = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-12&check_out=2026-07-14&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(((await turnover.json()) as { units: unknown[] }).units).toHaveLength(1)
  })

  it('invalid range → 400', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-13&check_out=2026-07-10&guests=2`,
      { headers: auth(ADMIN_EMAIL) },
    )
    expect(res.status).toBe(400)
  })

  it('AG37 — unit calendar marks blocked / booked / available days', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId, baseRate: 100000 })
    await seedBlockout(orgId, serviceId, unitId, '2026-07-11', '2026-07-12')
    await seedReservation(orgId, serviceId, unitId, '2026-07-13', '2026-07-15')

    const res = await SELF.fetch(
      `http://api.local/api/pos/lodging/units/${unitId}/calendar?from=2026-07-10&to=2026-07-15`,
      { headers: auth(ADMIN_EMAIL) },
    )
    const days = ((await res.json()) as { days: { date: string; status: string }[] }).days
    const byDate = Object.fromEntries(days.map((d) => [d.date, d.status]))
    expect(byDate['2026-07-10']).toBe('available')
    expect(byDate['2026-07-11']).toBe('blocked')
    expect(byDate['2026-07-13']).toBe('booked')
    expect(byDate['2026-07-14']).toBe('booked')
  })
})

// ============================================================================
// POS catalog lodging branch (spec §4.3)
// ============================================================================

describe('POS catalog lodging branch', () => {
  it('Sc6 — exposes from_nightly_rate and has_availability', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    await seedUnit({ organizationId: orgId, serviceId, baseRate: 120000 })
    await seedUnit({ organizationId: orgId, serviceId, name: 'Cabaña 2', baseRate: 90000 })

    const res = await SELF.fetch('http://api.local/api/pos/services', {
      headers: auth(ADMIN_EMAIL),
    })
    const services = ((await res.json()) as {
      services: { id: string; category: string; from_nightly_rate: number; has_availability: boolean }[]
    }).services
    const lodging = services.find((s) => s.id === serviceId)!
    expect(lodging.from_nightly_rate).toBe(90000)
    expect(lodging.has_availability).toBe(true)
  })
})

// ============================================================================
// POS sale path — stay lines on confirmSale (spec §4.4, scenarios 12/14/15/16)
// ============================================================================

interface SaleResponse {
  folio: {
    id: string
    status: string
    total: number
    lines: {
      line_type: string
      unit_id: string | null
      check_in: string | null
      check_out: string | null
      guests: number | null
      nights: number | null
      line_total: number
      qr_token: string | null
    }[]
  }
}

const sellStay = (
  unitId: string,
  checkIn: string,
  checkOut: string,
  guests: number,
  extra: Record<string, unknown> = {},
) =>
  SELF.fetch('http://api.local/api/pos/folios', {
    method: 'POST',
    headers: jsonAuth(ADMIN_EMAIL),
    body: JSON.stringify({
      customer_name: 'Cliente',
      customer_email: 'cliente@example.com',
      lines: [{ unit_id: unitId, check_in: checkIn, check_out: checkOut, guests }],
      ...extra,
    }),
  })

const reservationsForFolio = async (folioId: string) =>
  (
    await env.DB.prepare(
      'SELECT status, check_in, check_out FROM accommodation_reservations WHERE folio_id = ?',
    )
      .bind(folioId)
      .all<{ status: string; check_in: string; check_out: string }>()
  ).results

// The commission snapshot stored on the folio line (the waterfall's resolved result).
const commissionForFolio = async (folioId: string) =>
  (
    await env.DB.prepare(
      'SELECT commission_type, commission_value FROM folio_lines WHERE folio_id = ?',
    )
      .bind(folioId)
      .all<{ commission_type: string; commission_value: number }>()
  ).results

const sellStayFolioId = async (unitId: string, checkIn: string, checkOut: string, guests = 2) =>
  ((await (await sellStay(unitId, checkIn, checkOut, guests)).json()) as SaleResponse).folio.id

describe('POS lodging sale path', () => {
  it('Sc16 — a paid stay sale creates an active reservation + a stay folio line', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId, baseRate: 100000 })

    const res = await sellStay(unitId, '2026-07-10', '2026-07-13', 2)
    expect(res.status).toBe(201)
    const body = (await res.json()) as SaleResponse
    expect(body.folio.status).toBe('paid')
    expect(body.folio.total).toBe(300000)
    const line = body.folio.lines[0]
    expect(line.line_type).toBe('stay')
    expect(line.unit_id).toBe(unitId)
    expect(line.nights).toBe(3)
    expect(line.line_total).toBe(300000)
    expect(line.qr_token).toBeNull() // a stay has no per-line QR

    const reservations = await reservationsForFolio(body.folio.id)
    expect(reservations).toHaveLength(1)
    expect(reservations[0].status).toBe('active')
  })

  it('a stay folio reads back with its stay fields (POS + admin detail)', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId, baseRate: 100000 })
    const folioId = ((await (await sellStay(unitId, '2026-07-10', '2026-07-13', 2)).json()) as SaleResponse)
      .folio.id

    // POS receipt read (US-AG08).
    const pos = await SELF.fetch(`http://api.local/api/pos/folios/${folioId}`, {
      headers: auth(ADMIN_EMAIL),
    })
    const posLine = ((await pos.json()) as SaleResponse).folio.lines[0]
    expect(posLine.line_type).toBe('stay')
    expect(posLine.check_in).toBe('2026-07-10')
    expect(posLine.check_out).toBe('2026-07-13')
    expect(posLine.nights).toBe(3)
    expect(posLine.unit_id).toBe(unitId)

    // Admin folio detail (US-A21).
    const admin = await SELF.fetch(`http://api.local/api/folios/${folioId}`, {
      headers: auth(ADMIN_EMAIL),
    })
    const adminLine = ((await admin.json()) as { folio: { lines: { line_type: string; nights: number }[] } })
      .folio.lines[0]
    expect(adminLine.line_type).toBe('stay')
    expect(adminLine.nights).toBe(3)
  })

  it('Sc14 — the atomic guard rejects an overlapping range but allows checkout-day turnover', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId })

    expect((await sellStay(unitId, '2026-07-10', '2026-07-13', 2)).status).toBe(201)

    const overlap = await sellStay(unitId, '2026-07-12', '2026-07-14', 2)
    expect(overlap.status).toBe(409)
    expect(((await overlap.json()) as { error: { code: string } }).error.code).toBe('UNIT_UNAVAILABLE')

    // The overlap rollback must not strand a folio (it is compensated/deleted).
    const folioCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM folios').first<{ n: number }>()
    expect(folioCount!.n).toBe(1)

    // Turnover — starts on the prior stay's checkout day → allowed.
    expect((await sellStay(unitId, '2026-07-13', '2026-07-15', 2)).status).toBe(201)
  })

  it('Sc9 — a sale below min_nights → 400 MIN_STAY_NOT_MET', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId, minNights: 3 })
    const res = await sellStay(unitId, '2026-07-10', '2026-07-11', 2)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MIN_STAY_NOT_MET')
  })

  it('Sc7 — a sale over the unit capacity → 400', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId, maxCapacity: 4 })
    const res = await sellStay(unitId, '2026-07-10', '2026-07-12', 5)
    expect(res.status).toBe(400)
  })

  it('Sc15 — a deposit booking holds the dates; cancelling frees them for resale', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId, baseRate: 100000 })

    const booking = await sellStay(unitId, '2026-07-10', '2026-07-13', 2, {
      down_payment: 150000,
      customer_phone: '+525555555555',
    })
    expect(booking.status).toBe(201)
    const folio = ((await booking.json()) as SaleResponse).folio
    expect(folio.status).toBe('booking')
    expect((await reservationsForFolio(folio.id))[0].status).toBe('active')

    // The held dates block a competing sale.
    expect((await sellStay(unitId, '2026-07-11', '2026-07-12', 2)).status).toBe(409)

    // Cancel the booking → reservation released.
    const cancel = await SELF.fetch(`http://api.local/api/pos/folios/${folio.id}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'Cliente canceló' }),
    })
    expect(cancel.status).toBe(200)
    expect((await reservationsForFolio(folio.id))[0].status).toBe('cancelled')

    // Same range is now sellable again.
    expect((await sellStay(unitId, '2026-07-10', '2026-07-13', 2)).status).toBe(201)
  })

  it('Sc15 — reactivating a cancelled stay booking re-claims its dates', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId })

    const booking = await sellStay(unitId, '2026-07-10', '2026-07-13', 2, {
      down_payment: 150000,
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

  it('Sc15 — reactivation fails if the dates were taken while the booking was cancelled', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId })

    const booking = await sellStay(unitId, '2026-07-10', '2026-07-13', 2, {
      down_payment: 150000,
      customer_phone: '+525555555555',
    })
    const folioId = ((await booking.json()) as SaleResponse).folio.id
    await SELF.fetch(`http://api.local/api/pos/folios/${folioId}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'temp' }),
    })

    // A competing sale grabs the freed dates.
    expect((await sellStay(unitId, '2026-07-11', '2026-07-12', 2)).status).toBe(201)

    const reactivate = await SELF.fetch(`http://api.local/api/pos/folios/${folioId}/reactivate`, {
      method: 'POST',
      headers: auth(ADMIN_EMAIL),
    })
    expect(reactivate.status).toBe(409)
    expect(((await reactivate.json()) as { error: { code: string } }).error.code).toBe(
      'UNIT_UNAVAILABLE',
    )
    // The reservation stays cancelled (reactivation rolled back).
    expect((await reservationsForFolio(folioId))[0].status).toBe('cancelled')
  })

  it('settling a stay booking pays it without stamping a QR on the stay line', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId, baseRate: 100000 })
    const booking = await sellStay(unitId, '2026-07-10', '2026-07-13', 2, {
      down_payment: 150000,
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
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId, baseRate: 100000 })
    // Org policy: free cancellation ≥ 7 days out, else a 50% penalty.
    await env.DB.prepare(
      'UPDATE organizations SET lodging_free_cancel_days = 7, lodging_cancel_penalty_pct = 50 WHERE id = ?',
    )
      .bind(orgId)
      .run()

    // Frozen clock is 2026-06-14. Check-in 2026-07-10 is 26 days out → inside the free window.
    const free = await sellStay(unitId, '2026-07-10', '2026-07-13', 2)
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
    const late = await sellStay(unitId, '2026-06-16', '2026-06-18', 2)
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
// Commission waterfall — per-unit override ?? service base (US-A12)
// ============================================================================

describe('lodging commission waterfall', () => {
  const unitInput = (extra: Record<string, unknown> = {}) => ({
    name: 'Suite', beds: 1, base_occupancy: 2, max_capacity: 3, base_rate: 120000, ...extra,
  })

  it('a unit with no override inherits the service base commission', async () => {
    const { serviceId } = await seedLodgingService(orgId, 'Hotel', { type: 'percent', value: 1000 })
    const { unitId } = await seedUnit({ organizationId: orgId, serviceId, baseRate: 100000 })
    const folioId = await sellStayFolioId(unitId, '2026-07-10', '2026-07-12')
    const [c] = await commissionForFolio(folioId)
    expect(c.commission_type).toBe('percent')
    expect(c.commission_value).toBe(1000) // inherited from the service
  })

  it('a unit percent override beats the service base', async () => {
    const { serviceId } = await seedLodgingService(orgId, 'Hotel', { type: 'percent', value: 1000 })
    const { unitId } = await seedUnit({
      organizationId: orgId, serviceId, baseRate: 100000,
      commissionType: 'percent', commissionValue: 1500,
    })
    const [c] = await commissionForFolio(await sellStayFolioId(unitId, '2026-07-10', '2026-07-12'))
    expect(c.commission_type).toBe('percent')
    expect(c.commission_value).toBe(1500)
  })

  it('a unit fixed override ($ per stay) beats the service base', async () => {
    const { serviceId } = await seedLodgingService(orgId, 'Hotel', { type: 'percent', value: 1000 })
    const { unitId } = await seedUnit({
      organizationId: orgId, serviceId, baseRate: 100000,
      commissionType: 'fixed', commissionValue: 50000,
    })
    const [c] = await commissionForFolio(await sellStayFolioId(unitId, '2026-07-10', '2026-07-12'))
    expect(c.commission_type).toBe('fixed')
    expect(c.commission_value).toBe(50000)
  })

  it('admin can create a unit with a percent override, and omitting it inherits (null)', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const withOverride = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
      method: 'POST', headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify(unitInput({ commission_type: 'percent', commission_value: 1500 })),
    })
    expect(withOverride.status).toBe(201)
    expect((await withOverride.json() as { unit: { commission_type: string | null; commission_value: number | null } }).unit)
      .toMatchObject({ commission_type: 'percent', commission_value: 1500 })

    const inherit = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
      method: 'POST', headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify(unitInput({ name: 'Cabaña' })),
    })
    expect(inherit.status).toBe(201)
    expect((await inherit.json() as { unit: { commission_type: string | null } }).unit.commission_type).toBeNull()
  })

  it('rejects a unit override with a type but no value (400)', async () => {
    const { serviceId } = await seedLodgingService(orgId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
      method: 'POST', headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify(unitInput({ commission_type: 'fixed' })),
    })
    expect(res.status).toBe(400)
  })
})

// ============================================================================
// Multitenancy isolation — B1 / B3 / B4 (seedTwoOrgs)
// ============================================================================

describe('multitenancy', () => {
  it('B1 — injected organizationId is ignored on unit create', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { serviceId } = await seedLodgingService(orgA.organizationId)
    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
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
    const unitId = ((await res.json()) as { unit: { id: string } }).unit.id
    const row = await env.DB.prepare(
      'SELECT organization_id FROM accommodation_units WHERE id = ?',
    )
      .bind(unitId)
      .first<{ organization_id: string }>()
    expect(row!.organization_id).toBe(orgA.organizationId)
  })

  it('B3 — cross-org unit list / availability → 404', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { serviceId } = await seedLodgingService(orgA.organizationId)
    await seedUnit({ organizationId: orgA.organizationId, serviceId })

    // Org B admin lists units under org A's service → 404 (service not in their org).
    const list = await SELF.fetch(`http://api.local/api/services/${serviceId}/units`, {
      headers: auth(orgB.adminEmail),
    })
    expect(list.status).toBe(404)

    // Org B admin queries availability for org A's lodging service → 404.
    const avail = await SELF.fetch(
      `http://api.local/api/pos/lodging/${serviceId}/availability?check_in=2026-07-10&check_out=2026-07-12&guests=2`,
      { headers: auth(orgB.adminEmail) },
    )
    expect(avail.status).toBe(404)
  })

  it('B4 — availability is scoped to the caller org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const svcA = await seedLodgingService(orgA.organizationId)
    await seedUnit({ organizationId: orgA.organizationId, serviceId: svcA.serviceId })
    const svcB = await seedLodgingService(orgB.organizationId)
    await seedUnit({ organizationId: orgB.organizationId, serviceId: svcB.serviceId })

    // Org B catalog never shows org A's lodging service.
    const res = await SELF.fetch('http://api.local/api/pos/services', {
      headers: auth(orgB.adminEmail),
    })
    const ids = ((await res.json()) as { services: { id: string }[] }).services.map((s) => s.id)
    expect(ids).toContain(svcB.serviceId)
    expect(ids).not.toContain(svcA.serviceId)
  })
})
