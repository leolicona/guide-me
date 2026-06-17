import type { BatchItem } from 'drizzle-orm/batch'
import { and, eq, lte, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { folioLines, folios, slots } from '../../db/schema'

// US-AG07 (P3) — auto-expiry sweep. Cancels every booking past its `booking_expires_at`, releasing
// its held spots back into inventory (so the seats free up for last-minute walk-ins). The deposit
// is RETAINED (non-refundable, D7) — same accounting as a manual cancel. Run by the scheduled
// Worker (see src/index.tsx). Each write is filtered by the folio's OWN organization_id, so a
// foreign org's row can never be touched while processing another's. Returns the count swept.
export async function sweepExpiredBookings(env: CloudflareBindings): Promise<number> {
  const db = getDb(env)

  const expired = await db
    .select({ id: folios.id, organizationId: folios.organizationId })
    .from(folios)
    .where(
      and(eq(folios.status, 'booking'), lte(folios.bookingExpiresAt, new Date())),
    )

  let swept = 0
  for (const folio of expired) {
    const lineRows = await db
      .select({ slotId: folioLines.slotId, quantity: folioLines.quantity })
      .from(folioLines)
      .where(
        and(
          eq(folioLines.folioId, folio.id),
          eq(folioLines.organizationId, folio.organizationId),
        ),
      )

    const statements: BatchItem<'sqlite'>[] = [
      db
        .update(folios)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: null, // system
          cancellationReason: 'Apartado vencido',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(folios.id, folio.id),
            eq(folios.organizationId, folio.organizationId),
          ),
        ),
    ]
    for (const line of lineRows) {
      statements.push(
        db
          .update(slots)
          .set({
            booked: sql`${slots.booked} - ${line.quantity}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(slots.id, line.slotId),
              eq(slots.organizationId, folio.organizationId),
            ),
          ),
      )
    }
    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
    swept++
  }

  return swept
}
