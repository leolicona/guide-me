import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  accommodationBlockouts,
  accommodationReservations,
  accommodationSeasons,
  accommodationUnits,
  affiliateCommissions,
  organizations,
  services,
} from '../../db/schema'
import { ApiError } from '../../types/errors'
import {
  checkUnitAvailable,
  eachNight,
  nightlyRate,
  parseCsvInts,
  quoteStay,
  rangesOverlap,
  type SeasonRate,
} from '../../utils/lodging'
import type { PosContext } from './handler'

// docs/lodging/accommodation-stays.spec.md §4.2 — POS availability reads (agent/affiliate/admin).
// A stay occupies nights [check_in, check_out); availability uses the shared engine so the quote
// shown here can never drift from the quote enforced at confirmSale.

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

const unitCols = {
  id: accommodationUnits.id,
  name: accommodationUnits.name,
  unitType: accommodationUnits.unitType,
  beds: accommodationUnits.beds,
  baseOccupancy: accommodationUnits.baseOccupancy,
  maxCapacity: accommodationUnits.maxCapacity,
  baseRate: accommodationUnits.baseRate,
  weekendRate: accommodationUnits.weekendRate,
  extraPersonFee: accommodationUnits.extraPersonFee,
  minNights: accommodationUnits.minNights,
  checkinTime: accommodationUnits.checkinTime,
  checkoutTime: accommodationUnits.checkoutTime,
  amenities: accommodationUnits.amenities,
  status: accommodationUnits.status,
} as const

// Active seasons for a set of units that overlap [from, to] (inclusive), grouped by unit.
const seasonsByUnit = async (
  db: Db,
  org: string,
  from: string,
  to: string,
): Promise<Map<string, SeasonRate[]>> => {
  const rows = await db
    .select({
      unitId: accommodationSeasons.unitId,
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
    const list = map.get(r.unitId) ?? []
    list.push({ startDate: r.startDate, endDate: r.endDate, nightlyRate: r.nightlyRate })
    map.set(r.unitId, list)
  }
  return map
}

// US-AG36 — range-first availability: the units of a lodging service free for the WHOLE range,
// each with a quoteStay breakdown. Units that fail any availability rule are omitted.
export const getLodgingAvailability = async (c: PosContext) => {
  const agent = c.get('user')
  const serviceId = c.req.param('serviceId')
  const checkIn = c.req.query('check_in') ?? ''
  const checkOut = c.req.query('check_out') ?? ''
  const guests = Number(c.req.query('guests') ?? '1')
  const db = getDb(c.env)
  const org = agent.organizationId

  if (!dateRe.test(checkIn) || !dateRe.test(checkOut) || !(checkOut > checkIn)) {
    throw new ApiError('VALIDATION_ERROR', 400, 'A valid check_in < check_out range is required')
  }
  if (!Number.isInteger(guests) || guests < 1) {
    throw new ApiError('VALIDATION_ERROR', 400, 'guests must be a positive integer')
  }

  await requireLodgingService(db, c, serviceId)

  const units = await db
    .select(unitCols)
    .from(accommodationUnits)
    .where(
      and(
        eq(accommodationUnits.organizationId, org),
        eq(accommodationUnits.serviceId, serviceId),
        eq(accommodationUnits.status, 'active'),
      ),
    )
    .orderBy(asc(accommodationUnits.name))

  const weekendDays = await orgWeekendDays(db, org)
  const seasons = await seasonsByUnit(db, org, checkIn, checkOut)

  // Block-outs and active reservations that touch the range, grouped by unit.
  const blockoutRows = await db
    .select({
      unitId: accommodationBlockouts.unitId,
      startDate: accommodationBlockouts.startDate,
      endDate: accommodationBlockouts.endDate,
    })
    .from(accommodationBlockouts)
    .where(
      and(
        eq(accommodationBlockouts.organizationId, org),
        eq(accommodationBlockouts.serviceId, serviceId),
        lte(accommodationBlockouts.startDate, checkOut),
        gte(accommodationBlockouts.endDate, checkIn),
      ),
    )
  const reservationRows = await db
    .select({
      unitId: accommodationReservations.unitId,
      checkIn: accommodationReservations.checkIn,
      checkOut: accommodationReservations.checkOut,
    })
    .from(accommodationReservations)
    .where(
      and(
        eq(accommodationReservations.organizationId, org),
        eq(accommodationReservations.serviceId, serviceId),
        eq(accommodationReservations.status, 'active'),
        lte(accommodationReservations.checkIn, checkOut),
        gte(accommodationReservations.checkOut, checkIn),
      ),
    )

  const blockoutsByUnit = new Map<string, { startDate: string; endDate: string }[]>()
  for (const b of blockoutRows) {
    const list = blockoutsByUnit.get(b.unitId) ?? []
    list.push({ startDate: b.startDate, endDate: b.endDate })
    blockoutsByUnit.set(b.unitId, list)
  }
  const reservationsByUnit = new Map<string, { checkIn: string; checkOut: string }[]>()
  for (const r of reservationRows) {
    const list = reservationsByUnit.get(r.unitId) ?? []
    list.push({ checkIn: r.checkIn, checkOut: r.checkOut })
    reservationsByUnit.set(r.unitId, list)
  }

  const result = units
    .filter(
      (u) =>
        checkUnitAvailable(
          u,
          checkIn,
          checkOut,
          guests,
          blockoutsByUnit.get(u.id) ?? [],
          reservationsByUnit.get(u.id) ?? [],
        ) === null,
    )
    .map((u) => {
      const quote = quoteStay(
        u,
        checkIn,
        checkOut,
        guests,
        seasons.get(u.id) ?? [],
        weekendDays,
      )
      return {
        unit_id: u.id,
        name: u.name,
        unit_type: u.unitType,
        beds: u.beds,
        base_occupancy: u.baseOccupancy,
        max_capacity: u.maxCapacity,
        amenities: u.amenities ? u.amenities.split(',') : [],
        checkin_time: u.checkinTime,
        checkout_time: u.checkoutTime,
        nights: quote.nights,
        total: quote.total,
        per_night: quote.perNight.map((n) => ({ date: n.date, rate: n.rate })),
      }
    })

  return c.json({ check_in: checkIn, check_out: checkOut, guests, units: result })
}

// US-AG37 — unit-first: a unit's day-by-day status + rate over [from, to].
export const getUnitCalendar = async (c: PosContext) => {
  const agent = c.get('user')
  const unitId = c.req.param('unitId')
  const db = getDb(c.env)
  const org = agent.organizationId

  const from = c.req.query('from') ?? utcToday()
  const to = c.req.query('to') ?? addDays(from, 30)
  if (!dateRe.test(from) || !dateRe.test(to) || !(to >= from)) {
    throw new ApiError('VALIDATION_ERROR', 400, 'A valid from <= to range is required')
  }

  const unitRows = await db
    .select({
      id: accommodationUnits.id,
      serviceId: accommodationUnits.serviceId,
      baseRate: accommodationUnits.baseRate,
      weekendRate: accommodationUnits.weekendRate,
      status: accommodationUnits.status,
    })
    .from(accommodationUnits)
    .where(
      and(eq(accommodationUnits.id, unitId), eq(accommodationUnits.organizationId, org)),
    )
    .limit(1)
  const unit = unitRows[0]
  if (!unit || unit.status !== 'active') {
    throw new ApiError('NOT_FOUND', 404, 'Unit not found')
  }
  // Affiliate allow-list (the unit's parent service must be curated for them).
  await requireLodgingService(db, c, unit.serviceId)

  const weekendDays = await orgWeekendDays(db, org)
  const seasons = (await seasonsByUnit(db, org, from, to)).get(unitId) ?? []

  // `to` is the last day shown; include its night, so the night-range is [from, to+1).
  const toExclusive = addDays(to, 1)
  const blockouts = (
    await db
      .select({
        startDate: accommodationBlockouts.startDate,
        endDate: accommodationBlockouts.endDate,
      })
      .from(accommodationBlockouts)
      .where(
        and(
          eq(accommodationBlockouts.organizationId, org),
          eq(accommodationBlockouts.unitId, unitId),
          lte(accommodationBlockouts.startDate, toExclusive),
          gte(accommodationBlockouts.endDate, from),
        ),
      )
  ).map((b) => ({ start: b.startDate, end: b.endDate }))
  const reservations = (
    await db
      .select({
        checkIn: accommodationReservations.checkIn,
        checkOut: accommodationReservations.checkOut,
      })
      .from(accommodationReservations)
      .where(
        and(
          eq(accommodationReservations.organizationId, org),
          eq(accommodationReservations.unitId, unitId),
          eq(accommodationReservations.status, 'active'),
          lte(accommodationReservations.checkIn, toExclusive),
          gte(accommodationReservations.checkOut, from),
        ),
      )
  ).map((r) => ({ start: r.checkIn, end: r.checkOut }))

  const days = eachNight(from, toExclusive).map((date) => {
    const dayEnd = addDays(date, 1)
    let status: 'available' | 'blocked' | 'booked' = 'available'
    if (blockouts.some((b) => rangesOverlap(date, dayEnd, b.start, b.end))) {
      status = 'blocked'
    } else if (reservations.some((r) => rangesOverlap(date, dayEnd, r.start, r.end))) {
      status = 'booked'
    }
    return { date, status, rate: nightlyRate(date, unit, seasons, weekendDays) }
  })

  return c.json({ unit_id: unitId, days })
}

// listPosServices lodging branch (spec §4.3): per lodging service, `from_nightly_rate` (min unit
// base_rate) and a windowed `has_availability` (≥ 1 active unit with ≥ 1 free night in the window).
// Reservations/blockouts are checked per night via the shared overlap rule. Returns a map keyed by
// serviceId for the catalog serializer to merge in.
export const lodgingCatalogInfo = async (
  db: Db,
  org: string,
  lodgingServiceIds: string[],
  windowFrom: string,
  windowTo: string,
): Promise<Map<string, { hasAvailability: boolean; fromNightlyRate: number | null }>> => {
  const out = new Map<string, { hasAvailability: boolean; fromNightlyRate: number | null }>()
  if (lodgingServiceIds.length === 0) return out

  const units = await db
    .select({
      id: accommodationUnits.id,
      serviceId: accommodationUnits.serviceId,
      baseRate: accommodationUnits.baseRate,
    })
    .from(accommodationUnits)
    .where(
      and(
        eq(accommodationUnits.organizationId, org),
        eq(accommodationUnits.status, 'active'),
      ),
    )

  // The window covers nights [windowFrom, windowTo] inclusive → night-range end is windowTo+1.
  const windowEnd = addDays(windowTo, 1)
  const nights = eachNight(windowFrom, windowEnd)

  const blockouts = await db
    .select({
      unitId: accommodationBlockouts.unitId,
      startDate: accommodationBlockouts.startDate,
      endDate: accommodationBlockouts.endDate,
    })
    .from(accommodationBlockouts)
    .where(
      and(
        eq(accommodationBlockouts.organizationId, org),
        lte(accommodationBlockouts.startDate, windowEnd),
        gte(accommodationBlockouts.endDate, windowFrom),
      ),
    )
  const reservations = await db
    .select({
      unitId: accommodationReservations.unitId,
      checkIn: accommodationReservations.checkIn,
      checkOut: accommodationReservations.checkOut,
    })
    .from(accommodationReservations)
    .where(
      and(
        eq(accommodationReservations.organizationId, org),
        eq(accommodationReservations.status, 'active'),
        lte(accommodationReservations.checkIn, windowEnd),
        gte(accommodationReservations.checkOut, windowFrom),
      ),
    )
  const boByUnit = new Map<string, { startDate: string; endDate: string }[]>()
  for (const b of blockouts) {
    const l = boByUnit.get(b.unitId) ?? []
    l.push(b)
    boByUnit.set(b.unitId, l)
  }
  const resByUnit = new Map<string, { checkIn: string; checkOut: string }[]>()
  for (const r of reservations) {
    const l = resByUnit.get(r.unitId) ?? []
    l.push(r)
    resByUnit.set(r.unitId, l)
  }

  const wanted = new Set(lodgingServiceIds)
  for (const u of units) {
    if (!wanted.has(u.serviceId)) continue
    const entry = out.get(u.serviceId) ?? { hasAvailability: false, fromNightlyRate: null }
    entry.fromNightlyRate =
      entry.fromNightlyRate === null ? u.baseRate : Math.min(entry.fromNightlyRate, u.baseRate)

    if (!entry.hasAvailability) {
      const bo = boByUnit.get(u.id) ?? []
      const res = resByUnit.get(u.id) ?? []
      const hasFreeNight = nights.some((d) => {
        const dEnd = addDays(d, 1)
        const blocked = bo.some((b) => rangesOverlap(d, dEnd, b.startDate, b.endDate))
        const booked = res.some((r) => rangesOverlap(d, dEnd, r.checkIn, r.checkOut))
        return !blocked && !booked
      })
      if (hasFreeNight) entry.hasAvailability = true
    }
    out.set(u.serviceId, entry)
  }
  // A lodging service with no units stays absent → catalog serializer treats it as no availability.
  return out
}
