import { and, asc, eq, gte, ne, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { getDb } from '../../db/client'
import type { Db } from '../../db/client'
import { folioLines, serviceZones, services, slots, slotZones } from '../../db/schema'
import { ApiError } from '../../types/errors'
import { requireService, type ServicesContext } from './handler'
import type { CreateZoneInput, EnableZonesInput, UpdateZoneInput } from './zones.schema'
import { buildSlotZoneInserts, utcToday } from './zones.materialize'
import { reconcileFutureSlots, reconcileSlotTotals } from './zones.reconcile'

// Zoned Capacity (US-A64 — docs/catalog/zoned-capacity.spec.md). Admin CRUD over a slot-based
// service's physical zones + the enable/disable lifecycle. Mirrors the unit-types collection.

// --- Serializer ---

interface ZoneRow {
  id: string
  serviceId: string
  name: string
  capacity: number
  sortOrder: number
  status: string
}

const serializeZone = (row: ZoneRow) => ({
  id: row.id,
  service_id: row.serviceId,
  name: row.name,
  capacity: row.capacity,
  sort_order: row.sortOrder,
  status: row.status,
})

const zoneColumns = {
  id: serviceZones.id,
  serviceId: serviceZones.serviceId,
  name: serviceZones.name,
  capacity: serviceZones.capacity,
  sortOrder: serviceZones.sortOrder,
  status: serviceZones.status,
} as const

// --- Shared guards ---

const requireZone = async (
  db: Db,
  organizationId: string,
  serviceId: string,
  zoneId: string,
): Promise<ZoneRow> => {
  const rows = await db
    .select(zoneColumns)
    .from(serviceZones)
    .where(
      and(
        eq(serviceZones.id, zoneId),
        eq(serviceZones.serviceId, serviceId),
        eq(serviceZones.organizationId, organizationId),
      ),
    )
    .limit(1)
  if (!rows[0]) throw new ApiError('NOT_FOUND', 404, 'Zone not found')
  return rows[0]
}

// A case-insensitive name clash with another ACTIVE zone of the same service.
const activeNameConflict = async (
  db: Db,
  organizationId: string,
  serviceId: string,
  name: string,
  excludeZoneId?: string,
): Promise<boolean> => {
  const filters = [
    eq(serviceZones.organizationId, organizationId),
    eq(serviceZones.serviceId, serviceId),
    eq(serviceZones.status, 'active'),
    eq(sql`lower(${serviceZones.name})`, name.trim().toLowerCase()),
  ]
  if (excludeZoneId) filters.push(ne(serviceZones.id, excludeZoneId))
  const rows = await db.select({ id: serviceZones.id }).from(serviceZones).where(and(...filters)).limit(1)
  return rows.length > 0
}

const countActiveZones = async (db: Db, organizationId: string, serviceId: string): Promise<number> => {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(serviceZones)
    .where(
      and(
        eq(serviceZones.organizationId, organizationId),
        eq(serviceZones.serviceId, serviceId),
        eq(serviceZones.status, 'active'),
      ),
    )
  return rows[0]?.n ?? 0
}

// The org-scoped set of a service's FUTURE slot ids (a subquery — used in slot_zones filters so no
// slot id is ever bound into the statement, keeping the batch small regardless of departure count).
const futureSlotIds = (db: Db, organizationId: string, serviceId: string, today: string) =>
  db
    .select({ id: slots.id })
    .from(slots)
    .where(
      and(
        eq(slots.organizationId, organizationId),
        eq(slots.serviceId, serviceId),
        gte(slots.date, today),
      ),
    )

// --- Zone CRUD ---

// List a service's zones. Default active; ?status=inactive|all widens.
export const listZones = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const db = getDb(c.env)
  await requireService(db, admin.organizationId, serviceId)

  const filters = [
    eq(serviceZones.organizationId, admin.organizationId),
    eq(serviceZones.serviceId, serviceId),
  ]
  const status = c.req.query('status')
  if (status === 'all') {
    // no filter
  } else if (status === 'inactive') {
    filters.push(eq(serviceZones.status, 'inactive'))
  } else {
    filters.push(eq(serviceZones.status, 'active'))
  }

  const rows = await db
    .select(zoneColumns)
    .from(serviceZones)
    .where(and(...filters))
    .orderBy(asc(serviceZones.sortOrder))
  return c.json({ zones: rows.map(serializeZone) })
}

// Add ONE zone to an already-zoned service: inserts a snapshotted slot_zones row on every future
// slot in the same batch, then reconciles those departures (raising their derived capacity).
export const createZone = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const input = (await c.req.json()) as CreateZoneInput
  const db = getDb(c.env)

  const service = await requireService(db, admin.organizationId, serviceId)
  if (!service.zonesEnabled) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Enable zones on this service first')
  }
  if (await activeNameConflict(db, admin.organizationId, serviceId, input.name)) {
    throw new ApiError('CONFLICT', 409, 'A zone with that name already exists')
  }

  const today = utcToday()
  const zoneId = crypto.randomUUID()
  const slotIds = (await futureSlotIds(db, admin.organizationId, serviceId, today)).map((r) => r.id)

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(serviceZones).values({
      id: zoneId,
      organizationId: admin.organizationId,
      serviceId,
      name: input.name,
      capacity: input.capacity,
      sortOrder: input.sort_order ?? 0,
      status: 'active',
    }),
    ...buildSlotZoneInserts(db, admin.organizationId, slotIds, [
      { id: zoneId, capacity: input.capacity },
    ]),
    reconcileFutureSlots(db, admin.organizationId, serviceId, today),
  ]
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

  const [row] = await db.select(zoneColumns).from(serviceZones).where(eq(serviceZones.id, zoneId))
  return c.json({ zone: serializeZone(row) }, 201)
}

// Rename / resize / reorder. Shrinking below any future departure's sold seats → 409. On success,
// re-snapshots the future slot_zones and reconciles.
export const updateZone = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const zoneId = c.req.param('zoneId')
  const input = (await c.req.json()) as UpdateZoneInput
  const db = getDb(c.env)

  await requireZone(db, admin.organizationId, serviceId, zoneId)
  if (await activeNameConflict(db, admin.organizationId, serviceId, input.name, zoneId)) {
    throw new ApiError('CONFLICT', 409, 'A zone with that name already exists')
  }

  const today = utcToday()
  // Shrink guard: the most this zone has sold on any FUTURE departure.
  const maxRows = await db
    .select({ maxBooked: sql<number>`COALESCE(MAX(${slotZones.booked}), 0)` })
    .from(slotZones)
    .innerJoin(slots, eq(slots.id, slotZones.slotId))
    .where(
      and(
        eq(slotZones.organizationId, admin.organizationId),
        eq(slotZones.zoneId, zoneId),
        gte(slots.date, today),
      ),
    )
  const maxBooked = maxRows[0]?.maxBooked ?? 0
  if (input.capacity < maxBooked) {
    throw new ApiError(
      'CONFLICT',
      409,
      `Capacity cannot be below ${maxBooked} — a future departure has that many sold`,
    )
  }

  await db.batch([
    db
      .update(serviceZones)
      .set({ name: input.name, capacity: input.capacity, sortOrder: input.sort_order ?? 0, updatedAt: new Date() })
      .where(and(eq(serviceZones.id, zoneId), eq(serviceZones.organizationId, admin.organizationId))),
    // Re-snapshot future departures only; past rows stay frozen (rule 4 — no history rewrite).
    db
      .update(slotZones)
      .set({ capacity: input.capacity, updatedAt: new Date() })
      .where(
        and(
          eq(slotZones.organizationId, admin.organizationId),
          eq(slotZones.zoneId, zoneId),
          sqlInFutureSlots(admin.organizationId, serviceId, today),
        ),
      ),
    reconcileFutureSlots(db, admin.organizationId, serviceId, today),
  ])

  const [row] = await db.select(zoneColumns).from(serviceZones).where(eq(serviceZones.id, zoneId))
  return c.json({ zone: serializeZone(row) })
}

// Hard-delete — only when the zone was never sold (no booked slot_zones row, no folio line). Also
// removes its (zero-booked) slot_zones rows in the same batch. Steers to deactivate otherwise.
export const deleteZone = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const zoneId = c.req.param('zoneId')
  const db = getDb(c.env)

  await requireZone(db, admin.organizationId, serviceId, zoneId)

  const sold = await db
    .select({ id: slotZones.id })
    .from(slotZones)
    .where(
      and(
        eq(slotZones.organizationId, admin.organizationId),
        eq(slotZones.zoneId, zoneId),
        gte(slotZones.booked, 1),
      ),
    )
    .limit(1)
  const referenced = await db
    .select({ id: folioLines.id })
    .from(folioLines)
    .where(and(eq(folioLines.organizationId, admin.organizationId), eq(folioLines.zoneId, zoneId)))
    .limit(1)
  if (sold.length > 0 || referenced.length > 0) {
    throw new ApiError('CONFLICT', 409, 'This zone has sales — deactivate it instead')
  }

  if ((await countActiveZones(db, admin.organizationId, serviceId)) <= 2) {
    throw new ApiError('CONFLICT', 409, 'A zoned service needs at least 2 zones — disable zones instead')
  }

  const today = utcToday()
  await db.batch([
    // Zero-booked rows only (guaranteed by the guard above) — remove all of this zone's counters.
    db
      .delete(slotZones)
      .where(and(eq(slotZones.organizationId, admin.organizationId), eq(slotZones.zoneId, zoneId))),
    db
      .delete(serviceZones)
      .where(and(eq(serviceZones.id, zoneId), eq(serviceZones.organizationId, admin.organizationId))),
    reconcileFutureSlots(db, admin.organizationId, serviceId, today),
  ])
  return c.json({ deleted: true })
}

// Soft (de)activation. Deactivating flips the zone's FUTURE slot_zones to inactive (dropping out of
// the derived capacity) while past rows and sold lines remain. Reactivating flips them back.
const setZoneStatus = async (c: ServicesContext, status: 'active' | 'inactive') => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const zoneId = c.req.param('zoneId')
  const db = getDb(c.env)

  const zone = await requireZone(db, admin.organizationId, serviceId, zoneId)
  const today = utcToday()

  if (status === 'inactive' && zone.status === 'active') {
    // Must leave ≥ 2 active zones.
    if ((await countActiveZones(db, admin.organizationId, serviceId)) - 1 < 2) {
      throw new ApiError('CONFLICT', 409, 'A zoned service needs at least 2 zones — disable zones instead')
    }
  }
  if (status === 'active' && zone.status === 'inactive') {
    if (await activeNameConflict(db, admin.organizationId, serviceId, zone.name, zoneId)) {
      throw new ApiError('CONFLICT', 409, 'A zone with that name already exists')
    }
  }

  await db.batch([
    db
      .update(serviceZones)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(serviceZones.id, zoneId), eq(serviceZones.organizationId, admin.organizationId))),
    db
      .update(slotZones)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(slotZones.organizationId, admin.organizationId),
          eq(slotZones.zoneId, zoneId),
          sqlInFutureSlots(admin.organizationId, serviceId, today),
        ),
      ),
    reconcileFutureSlots(db, admin.organizationId, serviceId, today),
  ])

  const [row] = await db.select(zoneColumns).from(serviceZones).where(eq(serviceZones.id, zoneId))
  return c.json({ zone: serializeZone(row) })
}

export const deactivateZone = (c: ServicesContext) => setZoneStatus(c, 'inactive')
export const reactivateZone = (c: ServicesContext) => setZoneStatus(c, 'active')

// --- Enable / Disable lifecycle ---

// Enable zones on a slot-based service: define 2–6 zones, clear Soft Cap, eager-create snapshotted
// slot_zones for all future departures, assign any pre-existing future sales to a chosen zone, and
// backfill those folio lines. One batch.
export const enableZones = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const input = (await c.req.json()) as EnableZonesInput
  const db = getDb(c.env)

  const service = await requireService(db, admin.organizationId, serviceId)
  if (service.category === 'lodging') {
    throw new ApiError('VALIDATION_ERROR', 400, 'Lodging services use unit types, not zones')
  }
  if (service.zonesEnabled) {
    throw new ApiError('CONFLICT', 409, 'Zones are already enabled for this service')
  }

  const today = input.today ?? utcToday()
  const zoneRows = input.zones.map((z, i) => ({
    id: crypto.randomUUID(),
    organizationId: admin.organizationId,
    serviceId,
    name: z.name,
    capacity: z.capacity,
    sortOrder: z.sort_order ?? i,
    status: 'active' as const,
  }))

  // Future departures + their current booked total (the seats to re-home into one zone).
  const future = await db
    .select({ id: slots.id, booked: slots.booked })
    .from(slots)
    .where(
      and(
        eq(slots.organizationId, admin.organizationId),
        eq(slots.serviceId, serviceId),
        gte(slots.date, today),
      ),
    )
  const hasFutureSales = future.some((s) => s.booked > 0)
  if (hasFutureSales && input.assign_existing_to === undefined) {
    throw new ApiError(
      'VALIDATION_ERROR',
      400,
      'assign_existing_to is required — future departures already have sales',
    )
  }
  const assignZone = zoneRows[input.assign_existing_to ?? 0]

  const slotIds = future.map((s) => s.id)
  const zoneSpecs = zoneRows.map((z) => ({ id: z.id, capacity: z.capacity }))
  const seeds = future
    .filter((s) => s.booked > 0)
    .map((s) => ({ slotId: s.id, zoneId: assignZone.id, booked: s.booked }))

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(serviceZones).values(zoneRows),
    // US-A64 + US-A36 — enabling zones clears Soft Cap (strict per-zone ceilings make it unreachable).
    db
      .update(services)
      .set({ zonesEnabled: true, isFlexible: false, flexCapacityPct: 0, updatedAt: new Date() })
      .where(and(eq(services.id, serviceId), eq(services.organizationId, admin.organizationId))),
    ...buildSlotZoneInserts(db, admin.organizationId, slotIds, zoneSpecs, seeds),
  ]
  // Backfill pre-existing future-slot lines to the assign zone (service_id + slot_date filter, so
  // no slot-id list is bound). Without this, cancelling one of those folios would orphan its seats.
  if (hasFutureSales) {
    statements.push(
      db
        .update(folioLines)
        .set({ zoneId: assignZone.id, zoneName: assignZone.name })
        .where(
          and(
            eq(folioLines.organizationId, admin.organizationId),
            eq(folioLines.serviceId, serviceId),
            eq(folioLines.lineType, 'slot'),
            gte(folioLines.slotDate, today),
          ),
        ),
    )
  }
  statements.push(reconcileFutureSlots(db, admin.organizationId, serviceId, today))

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

  const [row] = await db
    .select({ zonesEnabled: services.zonesEnabled })
    .from(services)
    .where(eq(services.id, serviceId))
  const zones = await db
    .select(zoneColumns)
    .from(serviceZones)
    .where(and(eq(serviceZones.serviceId, serviceId), eq(serviceZones.status, 'active')))
    .orderBy(asc(serviceZones.sortOrder))
  return c.json({ zones_enabled: row.zonesEnabled, zones: zones.map(serializeZone) })
}

// Disable: collapse future departures to a single pool (freeze their derived total into slots),
// delete future slot_zones (pure counters — history lives on folio_lines.zone_name), deactivate the
// zone definitions for a clean re-enable. Past rows are kept frozen.
export const disableZones = async (c: ServicesContext) => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const db = getDb(c.env)

  const service = await requireService(db, admin.organizationId, serviceId)
  if (!service.zonesEnabled) {
    throw new ApiError('CONFLICT', 409, 'Zones are not enabled for this service')
  }
  const body = (await c.req.json().catch(() => ({}))) as { today?: string }
  const today = body.today ?? utcToday()

  await db.batch([
    // 1. Freeze each future slot's current derived total into the slot row BEFORE the rows vanish.
    reconcileFutureSlots(db, admin.organizationId, serviceId, today),
    // 2. Remove the future counters (past rows stay as frozen history).
    db
      .delete(slotZones)
      .where(
        and(
          eq(slotZones.organizationId, admin.organizationId),
          sqlInFutureSlots(admin.organizationId, serviceId, today),
        ),
      ),
    // 3. Flag the service unzoned + retain the definitions (deactivated) for a cheap re-enable.
    db
      .update(services)
      .set({ zonesEnabled: false, updatedAt: new Date() })
      .where(and(eq(services.id, serviceId), eq(services.organizationId, admin.organizationId))),
    db
      .update(serviceZones)
      .set({ status: 'inactive', updatedAt: new Date() })
      .where(
        and(
          eq(serviceZones.organizationId, admin.organizationId),
          eq(serviceZones.serviceId, serviceId),
        ),
      ),
  ])
  return c.json({ zones_enabled: false })
}

// --- Per-departure close / reopen (the rain case) ---

// Close a single departure's zone to NEW sales (its `slot_zones` row → inactive), or reopen it.
// Closing does not touch already-sold seats (they stay on their folios and scan normally); it just
// drops the zone from that departure's derived capacity until reopened. Eager creation means the
// row exists, but close tolerates a missing row by lazily inserting an inactive one (snapshot).
const setSlotZoneStatus = async (c: ServicesContext, status: 'active' | 'inactive') => {
  const admin = c.get('user')
  const serviceId = c.req.param('id')
  const slotId = c.req.param('slotId')
  const zoneId = c.req.param('zoneId')
  const db = getDb(c.env)

  const zone = await requireZone(db, admin.organizationId, serviceId, zoneId)
  // The slot must belong to this service + org (guards against pointing a foreign slot at this zone).
  const slotRows = await db
    .select({ id: slots.id })
    .from(slots)
    .where(
      and(
        eq(slots.id, slotId),
        eq(slots.serviceId, serviceId),
        eq(slots.organizationId, admin.organizationId),
      ),
    )
    .limit(1)
  if (!slotRows[0]) throw new ApiError('NOT_FOUND', 404, 'Slot not found')

  const existing = await db
    .select({ id: slotZones.id })
    .from(slotZones)
    .where(
      and(
        eq(slotZones.slotId, slotId),
        eq(slotZones.zoneId, zoneId),
        eq(slotZones.organizationId, admin.organizationId),
      ),
    )
    .limit(1)

  const mutation =
    existing.length > 0
      ? db
          .update(slotZones)
          .set({ status, updatedAt: new Date() })
          .where(
            and(
              eq(slotZones.slotId, slotId),
              eq(slotZones.zoneId, zoneId),
              eq(slotZones.organizationId, admin.organizationId),
            ),
          )
      : status === 'inactive'
        ? db.insert(slotZones).values({
            id: crypto.randomUUID(),
            organizationId: admin.organizationId,
            slotId,
            zoneId,
            capacity: zone.capacity, // snapshot
            booked: 0,
            status: 'inactive',
          })
        : null // reopen with no row = nothing to reopen
  if (!mutation) throw new ApiError('NOT_FOUND', 404, 'This zone is not closed on that departure')

  await db.batch([mutation, reconcileSlotTotals(db, slotId)])
  const [row] = await db
    .select({ capacity: slotZones.capacity, booked: slotZones.booked, status: slotZones.status })
    .from(slotZones)
    .where(and(eq(slotZones.slotId, slotId), eq(slotZones.zoneId, zoneId)))
  return c.json({
    slot_zone: {
      slot_id: slotId,
      zone_id: zoneId,
      capacity: row.capacity,
      booked: row.booked,
      remaining: row.capacity - row.booked,
      status: row.status,
    },
  })
}

export const closeSlotZone = (c: ServicesContext) => setSlotZoneStatus(c, 'inactive')
export const reopenSlotZone = (c: ServicesContext) => setSlotZoneStatus(c, 'active')

// A `slot_zones.slot_id IN (future slot ids of this service)` predicate, via a subquery so nothing
// is bound per slot.
function sqlInFutureSlots(organizationId: string, serviceId: string, today: string) {
  return sql`${slotZones.slotId} IN (SELECT ${slots.id} FROM ${slots}
    WHERE ${slots.organizationId} = ${organizationId}
      AND ${slots.serviceId} = ${serviceId}
      AND ${slots.date} >= ${today})`
}
