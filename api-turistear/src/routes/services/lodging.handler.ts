import { and, asc, eq, ne } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  accommodationBlockouts,
  accommodationSeasons,
  accommodationUnitTypes,
} from '../../db/schema'
import { ApiError } from '../../types/errors'
import { requireService, type ServicesContext } from './handler'
import type {
  CreateBlockoutInput,
  CreateSeasonInput,
  CreateUnitTypeInput,
  UpdateSeasonInput,
  UpdateUnitTypeInput,
} from './lodging.schema'

// Admin unit-type CRUD (docs/lodging/accommodation-stays.spec.md §4.1, v2 — unit-type inventory
// per the approved RFC). A `lodging` service owns unit types (`accommodation_unit_types`), each
// with an `inventory_count` pool; block-outs remove `quantity` rooms from that pool (D11).

// --- Serializers: DB columns → API shape (snake_case; amenities CSV → array) ---

interface UnitTypeRow {
  id: string
  serviceId: string
  name: string
  unitType: string | null
  inventoryCount: number
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
  commissionType: 'percent' | 'fixed' | null
  commissionValue: number | null
  status: string
}

const serializeUnitType = (row: UnitTypeRow) => ({
  id: row.id,
  service_id: row.serviceId,
  name: row.name,
  unit_type: row.unitType,
  inventory_count: row.inventoryCount,
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

const unitTypeColumns = {
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
  commissionType: accommodationUnitTypes.commissionType,
  commissionValue: accommodationUnitTypes.commissionValue,
  status: accommodationUnitTypes.status,
} as const

interface SeasonRow {
  id: string
  unitTypeId: string
  name: string
  startDate: string
  endDate: string
  nightlyRate: number
  status: string
}

const serializeSeason = (row: SeasonRow) => ({
  id: row.id,
  unit_type_id: row.unitTypeId,
  name: row.name,
  start_date: row.startDate,
  end_date: row.endDate,
  nightly_rate: row.nightlyRate,
  status: row.status,
})

const seasonColumns = {
  id: accommodationSeasons.id,
  unitTypeId: accommodationSeasons.unitTypeId,
  name: accommodationSeasons.name,
  startDate: accommodationSeasons.startDate,
  endDate: accommodationSeasons.endDate,
  nightlyRate: accommodationSeasons.nightlyRate,
  status: accommodationSeasons.status,
} as const

interface BlockoutRow {
  id: string
  unitTypeId: string
  quantity: number
  startDate: string
  endDate: string
  reason: string | null
}

const serializeBlockout = (row: BlockoutRow) => ({
  id: row.id,
  unit_type_id: row.unitTypeId,
  quantity: row.quantity,
  start_date: row.startDate,
  end_date: row.endDate,
  reason: row.reason,
})

const blockoutColumns = {
  id: accommodationBlockouts.id,
  unitTypeId: accommodationBlockouts.unitTypeId,
  quantity: accommodationBlockouts.quantity,
  startDate: accommodationBlockouts.startDate,
  endDate: accommodationBlockouts.endDate,
  reason: accommodationBlockouts.reason,
} as const

// Verify a unit type exists under this service in the caller's org → 404 otherwise. The triple
// filter (typeId + serviceId + organizationId) makes a wrong parent or foreign org resolve to 404.
const requireUnitType = async (
  db: ReturnType<typeof getDb>,
  organizationId: string,
  serviceId: string,
  typeId: string,
) => {
  const rows = await db
    .select(unitTypeColumns)
    .from(accommodationUnitTypes)
    .where(
      and(
        eq(accommodationUnitTypes.id, typeId),
        eq(accommodationUnitTypes.serviceId, serviceId),
        eq(accommodationUnitTypes.organizationId, organizationId),
      ),
    )
    .limit(1)
  if (!rows[0]) {
    throw new ApiError('NOT_FOUND', 404, 'Unit type not found')
  }
  return rows[0]
}

// --- Unit types ---

// US-A59 — create a unit type under a lodging service. organizationId from context (Rule 3).
export const createUnitType = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const input = (await c.req.json()) as CreateUnitTypeInput
  const db = getDb(c.env)

  const service = await requireService(db, admin.organizationId, serviceId)
  if (service.category !== 'lodging') {
    throw new ApiError(
      'VALIDATION_ERROR',
      400,
      'Unit types can only be added to a lodging service',
    )
  }

  const result = await db
    .insert(accommodationUnitTypes)
    .values({
      id: crypto.randomUUID(),
      organizationId: admin.organizationId,
      serviceId,
      name: input.name,
      unitType: input.unit_type ?? null,
      inventoryCount: input.inventory_count ?? 1,
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
    .returning(unitTypeColumns)

  return c.json({ unit_type: serializeUnitType(result[0]) }, 201)
}

// US-A59 — list a service's unit types, ordered by name. Default active; ?status widens.
export const listUnitTypes = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const db = getDb(c.env)

  await requireService(db, admin.organizationId, serviceId)

  const filters = [
    eq(accommodationUnitTypes.organizationId, admin.organizationId),
    eq(accommodationUnitTypes.serviceId, serviceId),
  ]
  const status = c.req.query('status')
  if (status === 'all') {
    // no status filter
  } else if (status === 'inactive') {
    filters.push(eq(accommodationUnitTypes.status, 'inactive'))
  } else {
    filters.push(eq(accommodationUnitTypes.status, 'active'))
  }

  const rows = await db
    .select(unitTypeColumns)
    .from(accommodationUnitTypes)
    .where(and(...filters))
    .orderBy(asc(accommodationUnitTypes.name))

  return c.json({ unit_types: rows.map(serializeUnitType) })
}

// US-A59/A60/A61/A62 — edit a unit type (full replace of editable fields). Lowering
// inventory_count below current occupancy is allowed (affects FUTURE availability only —
// existing reservations stand; open decision §8.5's default).
export const updateUnitType = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const typeId = c.req.param('typeId')
  const input = (await c.req.json()) as UpdateUnitTypeInput
  const db = getDb(c.env)

  await requireUnitType(db, admin.organizationId, serviceId, typeId)

  const result = await db
    .update(accommodationUnitTypes)
    .set({
      name: input.name,
      unitType: input.unit_type ?? null,
      inventoryCount: input.inventory_count ?? 1,
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
        eq(accommodationUnitTypes.id, typeId),
        eq(accommodationUnitTypes.serviceId, serviceId),
        eq(accommodationUnitTypes.organizationId, admin.organizationId),
      ),
    )
    .returning(unitTypeColumns)

  return c.json({ unit_type: serializeUnitType(result[0]) })
}

const setUnitTypeStatus = async (
  c: ServicesContext,
  status: 'active' | 'inactive',
) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const typeId = c.req.param('typeId')
  const db = getDb(c.env)

  await requireUnitType(db, admin.organizationId, serviceId, typeId)

  const result = await db
    .update(accommodationUnitTypes)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(accommodationUnitTypes.id, typeId),
        eq(accommodationUnitTypes.serviceId, serviceId),
        eq(accommodationUnitTypes.organizationId, admin.organizationId),
      ),
    )
    .returning(unitTypeColumns)

  return c.json({ unit_type: serializeUnitType(result[0]) })
}

export const deactivateUnitType = (c: ServicesContext) => setUnitTypeStatus(c, 'inactive')
export const reactivateUnitType = (c: ServicesContext) => setUnitTypeStatus(c, 'active')

// --- Seasons ---

// Inclusive-range overlap: two seasons [s1,e1] and [s2,e2] collide iff s1 <= e2 && s2 <= e1.
const activeSeasonOverlap = async (
  db: ReturnType<typeof getDb>,
  organizationId: string,
  typeId: string,
  startDate: string,
  endDate: string,
  excludeSeasonId?: string,
): Promise<boolean> => {
  const filters = [
    eq(accommodationSeasons.organizationId, organizationId),
    eq(accommodationSeasons.unitTypeId, typeId),
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
  const typeId = c.req.param('typeId')
  const input = (await c.req.json()) as CreateSeasonInput
  const db = getDb(c.env)

  await requireUnitType(db, admin.organizationId, serviceId, typeId)

  if (
    await activeSeasonOverlap(
      db,
      admin.organizationId,
      typeId,
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
      unitTypeId: typeId,
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
  const typeId = c.req.param('typeId')
  const db = getDb(c.env)

  await requireUnitType(db, admin.organizationId, serviceId, typeId)

  const filters = [
    eq(accommodationSeasons.organizationId, admin.organizationId),
    eq(accommodationSeasons.unitTypeId, typeId),
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
  const typeId = c.req.param('typeId')
  const seasonId = c.req.param('seasonId')
  const input = (await c.req.json()) as UpdateSeasonInput
  const db = getDb(c.env)

  await requireUnitType(db, admin.organizationId, serviceId, typeId)

  const existing = await db
    .select({ id: accommodationSeasons.id })
    .from(accommodationSeasons)
    .where(
      and(
        eq(accommodationSeasons.id, seasonId),
        eq(accommodationSeasons.unitTypeId, typeId),
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
      typeId,
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
        eq(accommodationSeasons.unitTypeId, typeId),
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
  const typeId = c.req.param('typeId')
  const seasonId = c.req.param('seasonId')
  const db = getDb(c.env)

  await requireUnitType(db, admin.organizationId, serviceId, typeId)

  const result = await db
    .update(accommodationSeasons)
    .set({ status: 'inactive', updatedAt: new Date() })
    .where(
      and(
        eq(accommodationSeasons.id, seasonId),
        eq(accommodationSeasons.unitTypeId, typeId),
        eq(accommodationSeasons.organizationId, admin.organizationId),
      ),
    )
    .returning(seasonColumns)

  if (!result[0]) {
    throw new ApiError('NOT_FOUND', 404, 'Season not found')
  }
  return c.json({ season: serializeSeason(result[0]) })
}

// --- Block-outs (v2, D11: quantity-based) ---

// US-A61 — add a quantity block-out: remove `quantity` rooms of the type for [start, end).
export const addBlockout = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const typeId = c.req.param('typeId')
  const input = (await c.req.json()) as CreateBlockoutInput
  const db = getDb(c.env)

  const unitType = await requireUnitType(db, admin.organizationId, serviceId, typeId)

  const quantity = input.quantity ?? 1
  // D11 — a single block-out can't exceed the pool. Overlapping block-outs may still SUM past
  // inventory_count (the per-night guard clamps remaining at 0), which is valid admin intent.
  if (quantity > unitType.inventoryCount) {
    throw new ApiError(
      'VALIDATION_ERROR',
      400,
      `quantity exceeds this type's inventory (${unitType.inventoryCount})`,
    )
  }

  const result = await db
    .insert(accommodationBlockouts)
    .values({
      id: crypto.randomUUID(),
      organizationId: admin.organizationId,
      serviceId,
      unitTypeId: typeId,
      quantity,
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
  const typeId = c.req.param('typeId')
  const db = getDb(c.env)

  await requireUnitType(db, admin.organizationId, serviceId, typeId)

  const rows = await db
    .select(blockoutColumns)
    .from(accommodationBlockouts)
    .where(
      and(
        eq(accommodationBlockouts.organizationId, admin.organizationId),
        eq(accommodationBlockouts.unitTypeId, typeId),
      ),
    )
    .orderBy(asc(accommodationBlockouts.startDate))

  return c.json({ blockouts: rows.map(serializeBlockout) })
}

// Hard-delete a block-out (no historical value). Triple filter → 404.
export const deleteBlockout = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const typeId = c.req.param('typeId')
  const blockoutId = c.req.param('blockoutId')
  const db = getDb(c.env)

  await requireUnitType(db, admin.organizationId, serviceId, typeId)

  const result = await db
    .delete(accommodationBlockouts)
    .where(
      and(
        eq(accommodationBlockouts.id, blockoutId),
        eq(accommodationBlockouts.unitTypeId, typeId),
        eq(accommodationBlockouts.organizationId, admin.organizationId),
      ),
    )
    .returning({ id: accommodationBlockouts.id })

  if (!result[0]) {
    throw new ApiError('NOT_FOUND', 404, 'Block-out not found')
  }
  return c.json({ deleted: true })
}
