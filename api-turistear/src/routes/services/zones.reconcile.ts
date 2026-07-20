import { and, eq, gte, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../db/client'
import { slots } from '../../db/schema'

// Zoned Capacity (US-A64 — docs/catalog/zoned-capacity.spec.md, rule 2).
//
// For a zoned service the authoritative per-zone counters live on `slot_zones`; `slots.capacity`
// and `slots.booked` are DERIVED from them so every existing read — the POS availability SQL, the
// catalog rollup, the date dots, sold-out styling, SlotRow — keeps working untouched. This builds
// the one idempotent statement that recomputes both totals as the sum over the slot's OPEN
// (`status = 'active'`) zones. A closed zone drops out of both sums, so its seats stop inflating
// availability while remaining on their folios.
//
// It returns a statement to COMPOSE into the caller's batch (never executes) so the reconcile
// commits in the SAME D1 transaction as the zone write that triggered it — no interactive
// transactions on D1, so atomicity is per-batch.
//
// CALLER CONTRACT: only invoke this for a ZONED slot. On an unzoned slot there are no `slot_zones`
// rows, so both sums are 0 and this would wrongly zero a legitimate `booked`. Every call site
// guards on `services.zones_enabled` (or on the line carrying a `zone_id`).
export function reconcileSlotTotals(db: Db, slotId: string): BatchItem<'sqlite'> {
  return db
    .update(slots)
    .set({
      booked: sql`(SELECT COALESCE(SUM(sz.booked), 0) FROM slot_zones sz
                    WHERE sz.slot_id = ${slotId} AND sz.status = 'active')`,
      capacity: sql`(SELECT COALESCE(SUM(sz.capacity), 0) FROM slot_zones sz
                      WHERE sz.slot_id = ${slotId} AND sz.status = 'active')`,
      updatedAt: new Date(),
    })
    .where(eq(slots.id, slotId))
}

// Reconcile EVERY future slot of a service in one statement — the correlated subquery keys on
// `slots.id`, so no slot id is bound and the batch stays tiny regardless of how many departures
// exist. Used by the admin zone operations (enable, add/edit/deactivate a zone) that touch all
// future departures at once. Same idempotent sums as the single-slot form.
export function reconcileFutureSlots(
  db: Db,
  organizationId: string,
  serviceId: string,
  today: string,
): BatchItem<'sqlite'> {
  return db
    .update(slots)
    .set({
      booked: sql`(SELECT COALESCE(SUM(sz.booked), 0) FROM slot_zones sz
                    WHERE sz.slot_id = ${slots.id} AND sz.status = 'active')`,
      capacity: sql`(SELECT COALESCE(SUM(sz.capacity), 0) FROM slot_zones sz
                      WHERE sz.slot_id = ${slots.id} AND sz.status = 'active')`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(slots.organizationId, organizationId),
        eq(slots.serviceId, serviceId),
        gte(slots.date, today),
      ),
    )
}
