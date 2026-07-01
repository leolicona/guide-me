import { and, asc, eq, ne } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  accommodationBlockouts,
  accommodationSeasons,
  accommodationUnits,
} from '../../db/schema'
import { ApiError } from '../../types/errors'
import { requireService, type ServicesContext } from './handler'
import type {
  CreateBlockoutInput,
  CreateSeasonInput,
  CreateUnitInput,
  UpdateSeasonInput,
  UpdateUnitInput,
} from './lodging.schema'

// --- Serializers: DB columns → API shape (snake_case; amenities CSV → array) ---

interface UnitRow {
  id: string
  serviceId: string
  name: string
  unitType: string | null
  beds: number
  baseOccupancy: number
  maxCapacity: number
  baseRate: number
  weekendRate: number | null
  extraPersonFee: number
  minNights: number
  checkinTime: string
  checkoutTime: string
  amenities: string
  status: string
}

const serializeUnit = (row: UnitRow) => ({
  id: row.id,
  service_id: row.serviceId,
  name: row.name,
  unit_type: row.unitType,
  beds: row.beds,
  base_occupancy: row.baseOccupancy,
  max_capacity: row.maxCapacity,
  base_rate: row.baseRate,
  weekend_rate: row.weekendRate,
  extra_person_fee: row.extraPersonFee,
  min_nights: row.minNights,
  checkin_time: row.checkinTime,
  checkout_time: row.checkoutTime,
  amenities: row.amenities ? row.amenities.split(',') : [],
  // Commission override (null ⇒ inherits the service rate).
  commission_type: row.commissionType,
  commission_value: row.commissionValue,
  status: row.status,
})

const unitColumns = {
  id: accommodationUnits.id,
  serviceId: accommodationUnits.serviceId,
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
  commissionType: accommodationUnits.commissionType,
  commissionValue: accommodationUnits.commissionValue,
  status: accommodationUnits.status,
} as const

interface SeasonRow {
  id: string
  unitId: string
  name: string
  startDate: string
  endDate: string
  nightlyRate: number
  status: string
}

const serializeSeason = (row: SeasonRow) => ({
  id: row.id,
  unit_id: row.unitId,
  name: row.name,
  start_date: row.startDate,
  end_date: row.endDate,
  nightly_rate: row.nightlyRate,
  status: row.status,
})

const seasonColumns = {
  id: accommodationSeasons.id,
  unitId: accommodationSeasons.unitId,
  name: accommodationSeasons.name,
  startDate: accommodationSeasons.startDate,
  endDate: accommodationSeasons.endDate,
  nightlyRate: accommodationSeasons.nightlyRate,
  status: accommodationSeasons.status,
} as const

interface BlockoutRow {
  id: string
  unitId: string
  startDate: string
  endDate: string
  reason: string | null
}

const serializeBlockout = (row: BlockoutRow) => ({
  id: row.id,
  unit_id: row.unitId,
  start_date: row.startDate,
  end_date: row.endDate,
  reason: row.reason,
})

const blockoutColumns = {
  id: accommodationBlockouts.id,
  unitId: accommodationBlockouts.unitId,
  startDate: accommodationBlockouts.startDate,
  endDate: accommodationBlockouts.endDate,
  reason: accommodationBlockouts.reason,
} as const

// Verify a unit exists under this service in the caller's org → 404 otherwise. The triple
// filter (unitId + serviceId + organizationId) makes a wrong parent or foreign org resolve to 404.
const requireUnit = async (
  db: ReturnType<typeof getDb>,
  organizationId: string,
  serviceId: string,
  unitId: string,
) => {
  const rows = await db
    .select(unitColumns)
    .from(accommodationUnits)
    .where(
      and(
        eq(accommodationUnits.id, unitId),
        eq(accommodationUnits.serviceId, serviceId),
        eq(accommodationUnits.organizationId, organizationId),
      ),
    )
    .limit(1)
  if (!rows[0]) {
    throw new ApiError('NOT_FOUND', 404, 'Unit not found')
  }
  return rows[0]
}

// --- Units ---

// US-A59 — create a named unit under a lodging service. organizationId from context (Rule 3).
export const createUnit = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const input = (await c.req.json()) as CreateUnitInput
  const db = getDb(c.env)

  const service = await requireService(db, admin.organizationId, serviceId)
  if (service.category !== 'lodging') {
    throw new ApiError(
      'VALIDATION_ERROR',
      400,
      'Units can only be added to a lodging service',
    )
  }

  const result = await db
    .insert(accommodationUnits)
    .values({
      id: crypto.randomUUID(),
      organizationId: admin.organizationId,
      serviceId,
      name: input.name,
      unitType: input.unit_type ?? null,
      beds: input.beds,
      baseOccupancy: input.base_occupancy,
      maxCapacity: input.max_capacity,
      baseRate: input.base_rate,
      weekendRate: input.weekend_rate ?? null,
      extraPersonFee: input.extra_person_fee ?? 0,
      minNights: input.min_nights ?? 1,
      checkinTime: input.checkin_time ?? '15:00',
      checkoutTime: input.checkout_time ?? '11:00',
      amenities: (input.amenities ?? []).join(','),
      commissionType: input.commission_type ?? null, // null ⇒ inherit service rate
      commissionValue: input.commission_value ?? null,
      status: 'active',
    })
    .returning(unitColumns)

  return c.json({ unit: serializeUnit(result[0]) }, 201)
}

// US-A59 — list a service's units, ordered by name. Default active; ?status=inactive|all widens.
export const listUnits = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const db = getDb(c.env)

  await requireService(db, admin.organizationId, serviceId)

  const filters = [
    eq(accommodationUnits.organizationId, admin.organizationId),
    eq(accommodationUnits.serviceId, serviceId),
  ]
  const status = c.req.query('status')
  if (status === 'all') {
    // no status filter
  } else if (status === 'inactive') {
    filters.push(eq(accommodationUnits.status, 'inactive'))
  } else {
    filters.push(eq(accommodationUnits.status, 'active'))
  }

  const rows = await db
    .select(unitColumns)
    .from(accommodationUnits)
    .where(and(...filters))
    .orderBy(asc(accommodationUnits.name))

  return c.json({ units: rows.map(serializeUnit) })
}

// US-A60/A61/A62 — edit a unit (full replace of editable fields).
export const updateUnit = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const unitId = c.req.param('unitId')
  const input = (await c.req.json()) as UpdateUnitInput
  const db = getDb(c.env)

  await requireUnit(db, admin.organizationId, serviceId, unitId)

  const result = await db
    .update(accommodationUnits)
    .set({
      name: input.name,
      unitType: input.unit_type ?? null,
      beds: input.beds,
      baseOccupancy: input.base_occupancy,
      maxCapacity: input.max_capacity,
      baseRate: input.base_rate,
      weekendRate: input.weekend_rate ?? null,
      extraPersonFee: input.extra_person_fee ?? 0,
      minNights: input.min_nights ?? 1,
      checkinTime: input.checkin_time ?? '15:00',
      checkoutTime: input.checkout_time ?? '11:00',
      amenities: (input.amenities ?? []).join(','),
      // Full replace: a PUT without an override clears it back to inherit.
      commissionType: input.commission_type ?? null,
      commissionValue: input.commission_value ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(accommodationUnits.id, unitId),
        eq(accommodationUnits.serviceId, serviceId),
        eq(accommodationUnits.organizationId, admin.organizationId),
      ),
    )
    .returning(unitColumns)

  return c.json({ unit: serializeUnit(result[0]) })
}

const setUnitStatus = async (
  c: ServicesContext,
  status: 'active' | 'inactive',
) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const unitId = c.req.param('unitId')
  const db = getDb(c.env)

  await requireUnit(db, admin.organizationId, serviceId, unitId)

  const result = await db
    .update(accommodationUnits)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(accommodationUnits.id, unitId),
        eq(accommodationUnits.serviceId, serviceId),
        eq(accommodationUnits.organizationId, admin.organizationId),
      ),
    )
    .returning(unitColumns)

  return c.json({ unit: serializeUnit(result[0]) })
}

export const deactivateUnit = (c: ServicesContext) => setUnitStatus(c, 'inactive')
export const reactivateUnit = (c: ServicesContext) => setUnitStatus(c, 'active')

// --- Seasons ---

// Inclusive-range overlap: two seasons [s1,e1] and [s2,e2] collide iff s1 <= e2 && s2 <= e1.
const activeSeasonOverlap = async (
  db: ReturnType<typeof getDb>,
  organizationId: string,
  unitId: string,
  startDate: string,
  endDate: string,
  excludeSeasonId?: string,
): Promise<boolean> => {
  const filters = [
    eq(accommodationSeasons.organizationId, organizationId),
    eq(accommodationSeasons.unitId, unitId),
    eq(accommodationSeasons.status, 'active'),
  ]
  if (excludeSeasonId) filters.push(ne(accommodationSeasons.id, excludeSeasonId))

  const rows = await db
    .select({
      id: accommodationSeasons.id,
      startDate: accommodationSeasons.startDate,
      endDate: accommodationSeasons.endDate,
    })
    .from(accommodationSeasons)
    .where(and(...filters))

  return rows.some((r) => startDate <= r.endDate && r.startDate <= endDate)
}

// US-A60 — add a seasonal rate. Rejects overlap with an existing active season (409).
export const addSeason = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const unitId = c.req.param('unitId')
  const input = (await c.req.json()) as CreateSeasonInput
  const db = getDb(c.env)

  await requireUnit(db, admin.organizationId, serviceId, unitId)

  if (
    await activeSeasonOverlap(
      db,
      admin.organizationId,
      unitId,
      input.start_date,
      input.end_date,
    )
  ) {
    throw new ApiError('SEASON_OVERLAP', 409, 'This season overlaps an existing one')
  }

  const result = await db
    .insert(accommodationSeasons)
    .values({
      id: crypto.randomUUID(),
      organizationId: admin.organizationId,
      serviceId,
      unitId,
      name: input.name,
      startDate: input.start_date,
      endDate: input.end_date,
      nightlyRate: input.nightly_rate,
      status: 'active',
    })
    .returning(seasonColumns)

  return c.json({ season: serializeSeason(result[0]) }, 201)
}

export const listSeasons = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const unitId = c.req.param('unitId')
  const db = getDb(c.env)

  await requireUnit(db, admin.organizationId, serviceId, unitId)

  const filters = [
    eq(accommodationSeasons.organizationId, admin.organizationId),
    eq(accommodationSeasons.unitId, unitId),
  ]
  const status = c.req.query('status')
  if (status === 'active' || status === 'inactive') {
    filters.push(eq(accommodationSeasons.status, status))
  } else {
    filters.push(eq(accommodationSeasons.status, 'active'))
  }

  const rows = await db
    .select(seasonColumns)
    .from(accommodationSeasons)
    .where(and(...filters))
    .orderBy(asc(accommodationSeasons.startDate))

  return c.json({ seasons: rows.map(serializeSeason) })
}

export const updateSeason = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const unitId = c.req.param('unitId')
  const seasonId = c.req.param('seasonId')
  const input = (await c.req.json()) as UpdateSeasonInput
  const db = getDb(c.env)

  await requireUnit(db, admin.organizationId, serviceId, unitId)

  const existing = await db
    .select({ id: accommodationSeasons.id })
    .from(accommodationSeasons)
    .where(
      and(
        eq(accommodationSeasons.id, seasonId),
        eq(accommodationSeasons.unitId, unitId),
        eq(accommodationSeasons.organizationId, admin.organizationId),
      ),
    )
    .limit(1)
  if (!existing[0]) {
    throw new ApiError('NOT_FOUND', 404, 'Season not found')
  }

  if (
    await activeSeasonOverlap(
      db,
      admin.organizationId,
      unitId,
      input.start_date,
      input.end_date,
      seasonId,
    )
  ) {
    throw new ApiError('SEASON_OVERLAP', 409, 'This season overlaps an existing one')
  }

  const result = await db
    .update(accommodationSeasons)
    .set({
      name: input.name,
      startDate: input.start_date,
      endDate: input.end_date,
      nightlyRate: input.nightly_rate,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(accommodationSeasons.id, seasonId),
        eq(accommodationSeasons.unitId, unitId),
        eq(accommodationSeasons.organizationId, admin.organizationId),
      ),
    )
    .returning(seasonColumns)

  return c.json({ season: serializeSeason(result[0]) })
}

// Soft-deactivate a season. Triple filter → 404. Idempotent.
export const deleteSeason = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const unitId = c.req.param('unitId')
  const seasonId = c.req.param('seasonId')
  const db = getDb(c.env)

  await requireUnit(db, admin.organizationId, serviceId, unitId)

  const result = await db
    .update(accommodationSeasons)
    .set({ status: 'inactive', updatedAt: new Date() })
    .where(
      and(
        eq(accommodationSeasons.id, seasonId),
        eq(accommodationSeasons.unitId, unitId),
        eq(accommodationSeasons.organizationId, admin.organizationId),
      ),
    )
    .returning(seasonColumns)

  if (!result[0]) {
    throw new ApiError('NOT_FOUND', 404, 'Season not found')
  }
  return c.json({ season: serializeSeason(result[0]) })
}

// --- Block-outs ---

// US-A61 — add a block-out range.
export const addBlockout = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const unitId = c.req.param('unitId')
  const input = (await c.req.json()) as CreateBlockoutInput
  const db = getDb(c.env)

  await requireUnit(db, admin.organizationId, serviceId, unitId)

  const result = await db
    .insert(accommodationBlockouts)
    .values({
      id: crypto.randomUUID(),
      organizationId: admin.organizationId,
      serviceId,
      unitId,
      startDate: input.start_date,
      endDate: input.end_date,
      reason: input.reason ?? null,
    })
    .returning(blockoutColumns)

  return c.json({ blockout: serializeBlockout(result[0]) }, 201)
}

export const listBlockouts = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const unitId = c.req.param('unitId')
  const db = getDb(c.env)

  await requireUnit(db, admin.organizationId, serviceId, unitId)

  const rows = await db
    .select(blockoutColumns)
    .from(accommodationBlockouts)
    .where(
      and(
        eq(accommodationBlockouts.organizationId, admin.organizationId),
        eq(accommodationBlockouts.unitId, unitId),
      ),
    )
    .orderBy(asc(accommodationBlockouts.startDate))

  return c.json({ blockouts: rows.map(serializeBlockout) })
}

// Hard-delete a block-out (no historical value). Triple filter → 404.
export const deleteBlockout = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const unitId = c.req.param('unitId')
  const blockoutId = c.req.param('blockoutId')
  const db = getDb(c.env)

  await requireUnit(db, admin.organizationId, serviceId, unitId)

  const result = await db
    .delete(accommodationBlockouts)
    .where(
      and(
        eq(accommodationBlockouts.id, blockoutId),
        eq(accommodationBlockouts.unitId, unitId),
        eq(accommodationBlockouts.organizationId, admin.organizationId),
      ),
    )
    .returning({ id: accommodationBlockouts.id })

  if (!result[0]) {
    throw new ApiError('NOT_FOUND', 404, 'Block-out not found')
  }
  return c.json({ deleted: true })
}
