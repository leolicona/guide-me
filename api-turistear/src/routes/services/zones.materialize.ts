import { and, eq, inArray } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../db/client'
import { serviceZones, slotZones } from '../../db/schema'

// Zoned Capacity (US-A64 — docs/catalog/zoned-capacity.spec.md). Pure, context-free helpers shared
// by the zone routes (enable / add-zone) and by slot materialization (createSchedule / createSlot),
// so a new slot on a zoned service gets its `slot_zones` rows in the SAME atomic batch as the slot
// — a slot must never exist without its zone rows (the BUG-012 atomicity lesson).

// D1 caps bound parameters per statement at 100. A slot_zones insert binds 7 values per row
// (id, organization_id, slot_id, zone_id, capacity, booked, status — timestamps use SQL defaults),
// so the chunk size is DERIVED, never hand-tuned.
const SLOT_ZONE_BOUND_COLUMNS = 7
const D1_MAX_BOUND_PARAMETERS = 100
export const SLOT_ZONE_INSERT_CHUNK = Math.floor(
  D1_MAX_BOUND_PARAMETERS / SLOT_ZONE_BOUND_COLUMNS,
)

/** Org-local today as a naive 'YYYY-MM-DD' (matches the POS `utcToday` model). */
export const utcToday = (): string => new Date().toISOString().slice(0, 10)

export interface ZoneSpec {
  id: string
  capacity: number
}

/** A service's ACTIVE zones (id + snapshot-source capacity), ordered by sort_order. */
export async function activeZonesForService(
  db: Db,
  organizationId: string,
  serviceId: string,
): Promise<ZoneSpec[]> {
  return db
    .select({ id: serviceZones.id, capacity: serviceZones.capacity })
    .from(serviceZones)
    .where(
      and(
        eq(serviceZones.organizationId, organizationId),
        eq(serviceZones.serviceId, serviceId),
        eq(serviceZones.status, 'active'),
      ),
    )
    .orderBy(serviceZones.sortOrder)
}

/** A per-slot booked seed: on the given slot, the given zone starts at `booked` (the rest at 0). */
export interface BookedSeed {
  slotId: string
  zoneId: string
  booked: number
}

/**
 * Build the `slot_zones` INSERT statements for a set of slots × zones, snapshotting each zone's
 * capacity. One row per (slot, zone); `booked` defaults to 0 unless a matching `BookedSeed` says
 * otherwise (used by `enable` to land pre-existing sales in the chosen zone). Chunked under the
 * D1 bound-parameter cap. Returns statements to COMPOSE into the caller's batch (never executes).
 */
export function buildSlotZoneInserts(
  db: Db,
  organizationId: string,
  slotIds: string[],
  zones: ZoneSpec[],
  seeds: BookedSeed[] = [],
): BatchItem<'sqlite'>[] {
  if (slotIds.length === 0 || zones.length === 0) return []

  const seedOf = new Map(seeds.map((s) => [`${s.slotId}:${s.zoneId}`, s.booked]))
  const rows = slotIds.flatMap((slotId) =>
    zones.map((zone) => ({
      id: crypto.randomUUID(),
      organizationId,
      slotId,
      zoneId: zone.id,
      capacity: zone.capacity,
      booked: seedOf.get(`${slotId}:${zone.id}`) ?? 0,
      status: 'active' as const,
    })),
  )

  const statements: BatchItem<'sqlite'>[] = []
  for (let i = 0; i < rows.length; i += SLOT_ZONE_INSERT_CHUNK) {
    statements.push(
      db.insert(slotZones).values(rows.slice(i, i + SLOT_ZONE_INSERT_CHUNK)),
    )
  }
  return statements
}

/** Delete a set of slots' zone rows (used by `disable`). Composed into the caller's batch. */
export function buildSlotZoneDeletes(
  db: Db,
  organizationId: string,
  slotIds: string[],
): BatchItem<'sqlite'>[] {
  if (slotIds.length === 0) return []
  return [
    db
      .delete(slotZones)
      .where(
        and(
          eq(slotZones.organizationId, organizationId),
          inArray(slotZones.slotId, slotIds),
        ),
      ),
  ]
}
