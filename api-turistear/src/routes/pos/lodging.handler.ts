import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  accommodationBlockouts,
  accommodationReservations,
  accommodationSeasons,
  accommodationUnitTypes,
  affiliateCommissions,
  organizations,
  services,
} from '../../db/schema'
import { ApiError } from '../../types/errors'
import {
  checkTypeAvailable,
  eachNight,
  minRemaining,
  nightlyRate,
  parseCsvInts,
  quoteStay,
  remainingOnNight,
  type QuantityRange,
  type SeasonRate,
} from '../../utils/lodging'
import type { PosContext } from './handler'

// docs/lodging/accommodation-stays.spec.md §4.2 (v2 — unit-type inventory) — POS availability
// reads (agent/affiliate/admin). A stay occupies nights [check_in, check_out); availability is
// per-night COUNT math (remaining = inventory_count − reserved − blocked) via the shared engine,
// so what's shown here can never drift from what confirmSale enforces.

const dateRe = /^\d{4}-\d{2}-\d{2}$/

const utcToday = () => new Date().toISOString().slice(0, 10)
const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

// The org's weekend-day set (defaults Fri+Sat) — feeds the rate engine.
const orgWeekendDays = async (db: Db, org: string): Promise<number[]> => {
  const rows = await db
    .select({ v: organizations.lodgingWeekendDays })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  return parseCsvInts(rows[0]?.v ?? '5,6')
}

// Verify a lodging service is active + in the caller's org (+ on an affiliate's allow-list).
const requireLodgingService = async (db: Db, c: PosContext, serviceId: string) => {
  const agent = c.get('user')
  const rows = await db
    .select({ id: services.id, category: services.category, status: services.status })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.organizationId, agent.organizationId)))
    .limit(1)
  const svc = rows[0]
  if (!svc || svc.status !== 'active' || svc.category !== 'lodging') {
    throw new ApiError('NOT_FOUND', 404, 'Service not found')
  }
  if (agent.role === 'affiliate') {
    const allowed = await db
      .select({ id: affiliateCommissions.id })
      .from(affiliateCommissions)
      .where(
        and(
          eq(affiliateCommissions.affiliateCompanyId, agent.affiliateCompanyId ?? ''),
          eq(affiliateCommissions.serviceId, serviceId),
        ),
      )
      .limit(1)
    if (allowed.length === 0) {
      throw new ApiError('NOT_FOUND', 404, 'Service not found')
    }
  }
}

const typeCols = {
  id: accommodationUnitTypes.id,
  serviceId: accommodationUnitTypes.serviceId,
  name: accommodationUnitTypes.name,
  unitType: accommodationUnitTypes.unitType,
  inventoryCount: accommodationUnitTypes.inventoryCount,
  beds: accommodationUnitTypes.beds,
  baseOccupancy: accommodationUnitTypes.baseOccupancy,
  maxCapacity: accommodationUnitTypes.maxCapacity,
  baseRate: accommodationUnitTypes.baseRate,
  weekendRate: accommodationUnitTypes.weekendRate,
  extraPersonFee: accommodationUnitTypes.extraPersonFee,
  minNights: accommodationUnitTypes.minNights,
  checkinTime: accommodationUnitTypes.checkinTime,
  checkoutTime: accommodationUnitTypes.checkoutTime,
  amenities: accommodationUnitTypes.amenities,
  status: accommodationUnitTypes.status,
} as const

// Active seasons for a set of types that overlap [from, to] (inclusive), grouped by type.
const seasonsByType = async (
  db: Db,
  org: string,
  from: string,
  to: string,
): Promise<Map<string, SeasonRate[]>> => {
  const rows = await db
    .select({
      unitTypeId: accommodationSeasons.unitTypeId,
      startDate: accommodationSeasons.startDate,
      endDate: accommodationSeasons.endDate,
      nightlyRate: accommodationSeasons.nightlyRate,
    })
    .from(accommodationSeasons)
    .where(
      and(
        eq(accommodationSeasons.organizationId, org),
        eq(accommodationSeasons.status, 'active'),
        lte(accommodationSeasons.startDate, to),
        gte(accommodationSeasons.endDate, from),
      ),
    )
  const map = new Map<string, SeasonRate[]>()
  for (const r of rows) {
    const list = map.get(r.unitTypeId) ?? []
    list.push({ startDate: r.startDate, endDate: r.endDate, nightlyRate: r.nightlyRate })
    map.set(r.unitTypeId, list)
  }
  return map
}

// The OCCUPANCY map (D10): every active reservation and every block-out that touches the
// half-open night window [from, endExclusive), as quantity ranges grouped by unit type.
// One pair of org-wide queries; callers narrow by type id.
const occupanciesByType = async (
  db: Db,
  org: string,
  from: string,
  endExclusive: string,
): Promise<Map<string, QuantityRange[]>> => {
  const blockouts = await db
    .select({
      unitTypeId: accommodationBlockouts.unitTypeId,
      start: accommodationBlockouts.startDate,
      end: accommodationBlockouts.endDate,
      quantity: accommodationBlockouts.quantity,
    })
    .from(accommodationBlockouts)
    .where(
      and(
        eq(accommodationBlockouts.organizationId, org),
        lte(accommodationBlockouts.startDate, endExclusive),
        gte(accommodationBlockouts.endDate, from),
      ),
    )
  const reservations = await db
    .select({
      unitTypeId: accommodationReservations.unitTypeId,
      start: accommodationReservations.checkIn,
      end: accommodationReservations.checkOut,
      quantity: accommodationReservations.quantity,
    })
    .from(accommodationReservations)
    .where(
      and(
        eq(accommodationReservations.organizationId, org),
        eq(accommodationReservations.status, 'active'),
        lte(accommodationReservations.checkIn, endExclusive),
        gte(accommodationReservations.checkOut, from),
      ),
    )
  const map = new Map<string, QuantityRange[]>()
  for (const row of [...blockouts, ...reservations]) {
    const list = map.get(row.unitTypeId) ?? []
    list.push({ start: row.start, end: row.end, quantity: row.quantity })
    map.set(row.unitTypeId, list)
  }
  return map
}

// US-AG36 — range-first availability: the unit types of a lodging service with enough per-night
// inventory for the WHOLE range × quantity, each with a quoteStay breakdown + min_remaining.
// Types that fail any §3.3 rule are omitted.
export const getLodgingAvailability = async (c: PosContext) => {
  const agent = c.get('user')
  const serviceId = c.req.param('serviceId')
  const checkIn = c.req.query('check_in') ?? ''
  const checkOut = c.req.query('check_out') ?? ''
  const guests = Number(c.req.query('guests') ?? '1')
  const quantity = Number(c.req.query('quantity') ?? '1')
  const db = getDb(c.env)
  const org = agent.organizationId

  if (!dateRe.test(checkIn) || !dateRe.test(checkOut) || !(checkOut > checkIn)) {
    throw new ApiError('VALIDATION_ERROR', 400, 'A valid check_in < check_out range is required')
  }
  if (!Number.isInteger(guests) || guests < 1) {
    throw new ApiError('VALIDATION_ERROR', 400, 'guests must be a positive integer')
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ApiError('VALIDATION_ERROR', 400, 'quantity must be a positive integer')
  }

  await requireLodgingService(db, c, serviceId)

  const types = await db
    .select(typeCols)
    .from(accommodationUnitTypes)
    .where(
      and(
        eq(accommodationUnitTypes.organizationId, org),
        eq(accommodationUnitTypes.serviceId, serviceId),
        eq(accommodationUnitTypes.status, 'active'),
      ),
    )
    .orderBy(asc(accommodationUnitTypes.name))

  const weekendDays = await orgWeekendDays(db, org)
  const seasons = await seasonsByType(db, org, checkIn, checkOut)
  const occupancies = await occupanciesByType(db, org, checkIn, checkOut)

  const result = types
    .filter(
      (t) =>
        checkTypeAvailable(
          t,
          checkIn,
          checkOut,
          guests,
          quantity,
          occupancies.get(t.id) ?? [],
        ) === null,
    )
    .map((t) => {
      const quote = quoteStay(
        t,
        checkIn,
        checkOut,
        guests,
        quantity,
        seasons.get(t.id) ?? [],
        weekendDays,
      )
      return {
        unit_type_id: t.id,
        name: t.name,
        unit_type: t.unitType,
        inventory_count: t.inventoryCount,
        min_remaining: minRemaining(
          t.inventoryCount,
          checkIn,
          checkOut,
          occupancies.get(t.id) ?? [],
        ),
        beds: t.beds,
        base_occupancy: t.baseOccupancy,
        max_capacity: t.maxCapacity,
        amenities: t.amenities ? t.amenities.split(',') : [],
        checkin_time: t.checkinTime,
        checkout_time: t.checkoutTime,
        nights: quote.nights,
        quantity,
        total: quote.total,
        per_night: quote.perNight.map((n) => ({ date: n.date, rate: n.rate })),
      }
    })

  return c.json({
    check_in: checkIn,
    check_out: checkOut,
    guests,
    quantity,
    unit_types: result,
  })
}

// US-AG37 — type-first: a unit type's day-by-day REMAINING count + rate over [from, to]
// (replaces the v1 binary free/blocked/booked calendar).
export const getUnitTypeCalendar = async (c: PosContext) => {
  const agent = c.get('user')
  const typeId = c.req.param('typeId')
  const db = getDb(c.env)
  const org = agent.organizationId

  const from = c.req.query('from') ?? utcToday()
  const to = c.req.query('to') ?? addDays(from, 30)
  if (!dateRe.test(from) || !dateRe.test(to) || !(to >= from)) {
    throw new ApiError('VALIDATION_ERROR', 400, 'A valid from <= to range is required')
  }

  const typeRows = await db
    .select({
      id: accommodationUnitTypes.id,
      serviceId: accommodationUnitTypes.serviceId,
      inventoryCount: accommodationUnitTypes.inventoryCount,
      baseRate: accommodationUnitTypes.baseRate,
      weekendRate: accommodationUnitTypes.weekendRate,
      status: accommodationUnitTypes.status,
    })
    .from(accommodationUnitTypes)
    .where(
      and(
        eq(accommodationUnitTypes.id, typeId),
        eq(accommodationUnitTypes.organizationId, org),
      ),
    )
    .limit(1)
  const unitType = typeRows[0]
  if (!unitType || unitType.status !== 'active') {
    throw new ApiError('NOT_FOUND', 404, 'Unit type not found')
  }
  // Affiliate allow-list (the type's parent service must be curated for them).
  await requireLodgingService(db, c, unitType.serviceId)

  const weekendDays = await orgWeekendDays(db, org)
  const seasons = (await seasonsByType(db, org, from, to)).get(typeId) ?? []

  // `to` is the last day shown; include its night, so the night-range is [from, to+1).
  const toExclusive = addDays(to, 1)
  const occupancies = (await occupanciesByType(db, org, from, toExclusive)).get(typeId) ?? []

  const days = eachNight(from, toExclusive).map((date) => ({
    date,
    remaining: remainingOnNight(unitType.inventoryCount, date, occupancies),
    rate: nightlyRate(date, unitType, seasons, weekendDays),
  }))

  return c.json({ unit_type_id: typeId, inventory_count: unitType.inventoryCount, days })
}

// listPosServices lodging branch (spec §4.3, D14 — flattened catalog): one CARD PER ACTIVE UNIT
// TYPE of the wanted lodging services, each with its exact nightly base rate, a windowed
// has_availability (per-night min remaining ≥ 1 over [windowFrom, windowTo]) and the `remaining`
// count that drives the "Quedan N" badge. The parent service is never a card.
export interface LodgingTypeCard {
  id: string
  serviceId: string
  name: string
  unitType: string | null
  nightlyRate: number
  /** Hard guest cap PER ROOM — lets the stay sheet cap its guests stepper before any quote. */
  maxCapacity: number
  hasAvailability: boolean
  remaining: number
}

export const lodgingTypeCards = async (
  db: Db,
  org: string,
  lodgingServiceIds: string[],
  windowFrom: string,
  windowTo: string,
): Promise<LodgingTypeCard[]> => {
  if (lodgingServiceIds.length === 0) return []

  const types = await db
    .select({
      id: accommodationUnitTypes.id,
      serviceId: accommodationUnitTypes.serviceId,
      name: accommodationUnitTypes.name,
      unitType: accommodationUnitTypes.unitType,
      inventoryCount: accommodationUnitTypes.inventoryCount,
      baseRate: accommodationUnitTypes.baseRate,
      maxCapacity: accommodationUnitTypes.maxCapacity,
    })
    .from(accommodationUnitTypes)
    .where(
      and(
        eq(accommodationUnitTypes.organizationId, org),
        eq(accommodationUnitTypes.status, 'active'),
      ),
    )
    .orderBy(asc(accommodationUnitTypes.name))

  // The window covers nights [windowFrom, windowTo] inclusive → night-range end is windowTo+1.
  const windowEnd = addDays(windowTo, 1)
  const occupancies = await occupanciesByType(db, org, windowFrom, windowEnd)

  const wanted = new Set(lodgingServiceIds)
  return types
    .filter((t) => wanted.has(t.serviceId))
    .map((t) => {
      const remaining = minRemaining(
        t.inventoryCount,
        windowFrom,
        windowEnd,
        occupancies.get(t.id) ?? [],
      )
      return {
        id: t.id,
        serviceId: t.serviceId,
        name: t.name,
        unitType: t.unitType,
        nightlyRate: t.baseRate,
        maxCapacity: t.maxCapacity,
        hasAvailability: remaining >= 1,
        remaining,
      }
    })
}

// availability/days lodging contribution (spec §4.3): the dates in [windowFrom, windowEnd]
// (inclusive) on which ANY active unit type of an active lodging service has remaining ≥ 1 —
// real dots for lodging days (retires the frontend's `lodgingInScope` exception).
export const lodgingAvailableDays = async (
  db: Db,
  org: string,
  windowFrom: string,
  windowEnd: string,
): Promise<Set<string>> => {
  const types = await db
    .select({
      id: accommodationUnitTypes.id,
      inventoryCount: accommodationUnitTypes.inventoryCount,
    })
    .from(accommodationUnitTypes)
    .innerJoin(services, eq(accommodationUnitTypes.serviceId, services.id))
    .where(
      and(
        eq(accommodationUnitTypes.organizationId, org),
        eq(accommodationUnitTypes.status, 'active'),
        eq(services.status, 'active'),
      ),
    )
  const out = new Set<string>()
  if (types.length === 0) return out

  const endExclusive = addDays(windowEnd, 1)
  const occupancies = await occupanciesByType(db, org, windowFrom, endExclusive)

  for (const night of eachNight(windowFrom, endExclusive)) {
    if (
      types.some(
        (t) => remainingOnNight(t.inventoryCount, night, occupancies.get(t.id) ?? []) >= 1,
      )
    ) {
      out.add(night)
    }
  }
  return out
}
