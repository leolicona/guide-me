import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../../db/client'
import {
  accommodationReservations,
  devoladaLinks,
  folioLines,
  folios,
  slots,
  slotZones,
} from '../../db/schema'
import { folioEventRowWhere } from '../../utils/folioEvents'
import { buildCancellationReversal } from '../../utils/folioPayments'
import { emitNotification } from '../../utils/notifications'
import { closeOpenLinksAfterWrite, closePaymentLinkRemote, markLinksClosingStatement } from '../devolada/links'
import { reconcileSlotTotals } from '../services/zones.reconcile'

// devolada-transfer-verification D11 — cancelling a sale when the money never arrived (FR-016).
//
// Devolada says a transfer was never found in time, or the sale's link expired with no payment
// after a successful re-read (D9, D12): the sale is void, as with the admin's Rechazar, but without
// Rechazar's defects (research defects 2 and 3). The system never cancels a sale that holds other
// money, one an admin verified by hand, or one with another payment still being decided.

export interface InventoryLine {
  slotId: string | null
  zoneId: string | null
  quantity: number
  /** Release this line's seats only while this holds; defaults to the input's `gate`. */
  gate?: SQL
}

/**
 * The seats and reservations a voided sale gives back, as statements for the caller's batch: a
 * zoned line's zone counter, then its slot's totals re-derived from the zones (US-A64); an unzoned
 * line's slot counter; and the sale's active stay reservations. Each counter is clamped at zero,
 * like every other release (`applyCancellation`), so a manually edited counter never goes negative.
 *
 * The admin's Rechazar passes every line of the sale (research defect 3 is its own); D11 passes
 * its live lines, each gated on its own cancellation in the same batch.
 */
export function buildInventoryReleaseStatements(
  db: Db,
  input: { organizationId: string; folioId: string; lines: InventoryLine[]; at: Date; gate?: SQL },
): BatchItem<'sqlite'>[] {
  const { organizationId: org, folioId, at } = input
  const statements: BatchItem<'sqlite'>[] = []
  for (const line of input.lines) {
    if (!line.slotId) continue // a stay line has no slot: its reservation is released below
    const gate = line.gate ?? input.gate
    if (line.zoneId) {
      statements.push(
        db
          .update(slotZones)
          .set({ booked: sql`MAX(0, ${slotZones.booked} - ${line.quantity})`, updatedAt: at })
          .where(
            and(
              eq(slotZones.slotId, line.slotId),
              eq(slotZones.zoneId, line.zoneId),
              eq(slotZones.organizationId, org),
              gate,
            ),
          ),
        // Re-derives the totals from the zones: idempotent, so it needs no gate of its own.
        reconcileSlotTotals(db, line.slotId),
      )
    } else {
      statements.push(
        db
          .update(slots)
          .set({ booked: sql`MAX(0, ${slots.booked} - ${line.quantity})`, updatedAt: at })
          .where(and(eq(slots.id, line.slotId), eq(slots.organizationId, org), gate)),
      )
    }
  }
  statements.push(
    db
      .update(accommodationReservations)
      .set({ status: 'cancelled', updatedAt: at })
      .where(
        and(
          eq(accommodationReservations.folioId, folioId),
          eq(accommodationReservations.organizationId, org),
          eq(accommodationReservations.status, 'active'),
          input.gate,
        ),
      ),
  )
  return statements
}

export interface UnreceivedTransferDeps {
  db: Db
  env: CloudflareBindings
  waitUntil: (promise: Promise<unknown>) => void
}

/** The reason a sale cancelled by D11 shows, beside `cancellation_source 'payment_not_received'`. */
export const PAYMENT_NOT_RECEIVED_REASON = 'No se recibió la transferencia'

/**
 * D11 — the transfer a link collects never arrived. Four steps:
 * 1. **Claim the link** (`open` → `expired`): one worker wins; any other gets `'noop'`.
 * 2. **Check the sale**: it goes on only while the sale is not cancelled, the link's own row is
 *    still pending (an admin may have verified it by hand), no payment of the sale is in flight
 *    and undecided (one the admin accepted or dismissed does not count, whatever its last snapshot
 *    says, D21), and that row is the sale's only positive money. Otherwise `'kept'`: the link stays
 *    `expired` and is left as Devolada has it, so money that still arrives on it is verified; a
 *    sale still pending stays in Por verificar, labelled «No recibido» (D14). A settlement link
 *    always ends here: an unpaid settlement leaves the apartado intact (D8).
 * 3. **One batch** whose first statement cancels the sale while every check of step 2 still holds,
 *    and every later statement is gated on that transition (constitution V): the read in step 2 is
 *    an early answer, never the guard.
 * 4. **After the batch**: the `payment_rejected` message, then the claimed link and the sale's
 *    other links, now `closing`, are closed at Devolada (D13), fail-soft.
 */
export async function cancelForUnreceivedTransfer(
  deps: UnreceivedTransferDeps,
  input: { organizationId: string; folioId: string; linkId: string; at: Date },
): Promise<'cancelled' | 'kept' | 'noop'> {
  const { db } = deps
  const { organizationId: org, folioId, linkId } = input
  // Stored to the second: the gates below compare the stamp the first statement wrote.
  const atSec = Math.floor(input.at.getTime() / 1000)
  const at = new Date(atSec * 1000)

  // 1. Claim the link.
  const [link] = await db
    .update(devoladaLinks)
    .set({ state: 'expired', updatedAt: at })
    .where(
      and(
        eq(devoladaLinks.id, linkId),
        eq(devoladaLinks.organizationId, org),
        eq(devoladaLinks.folioId, folioId),
        eq(devoladaLinks.state, 'open'),
      ),
    )
    .returning()
  if (!link) return 'noop'

  const rowId = link.kind === 'settlement' ? null : link.folioPaymentId
  if (!rowId) return 'kept'

  // 2. Check the sale. Each check is a condition the batch's first statement repeats.
  const rowStillPending = sql`EXISTS (SELECT 1 FROM folio_payments fp
    WHERE fp.id = ${rowId} AND fp.organization_id = ${org} AND fp.folio_id = ${folioId}
      AND fp.entry_type = 'payment' AND fp.verification = 'pending')`
  const noOtherMoney = sql`NOT EXISTS (SELECT 1 FROM folio_payments fp
    WHERE fp.organization_id = ${org} AND fp.folio_id = ${folioId}
      AND fp.entry_type = 'payment' AND fp.amount > 0 AND fp.id <> ${rowId})`
  const noPaymentUndecided = sql`NOT EXISTS (SELECT 1 FROM devolada_payments dp
    WHERE dp.organization_id = ${org} AND dp.folio_id = ${folioId}
      AND dp.status IN ('validating', 'queued_for_credit') AND dp.resolution IS NULL)`
  const [sale] = await db
    .select({
      agentId: folios.agentId,
      customerEmail: folios.customerEmail,
      cancellable: sql<number>`(${folios.cancelledAt} IS NULL AND ${rowStillPending} AND ${noOtherMoney} AND ${noPaymentUndecided})`,
    })
    .from(folios)
    .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
    .limit(1)
  if (!sale || !sale.cancellable) return 'kept'

  const liveLines = await db
    .select({ id: folioLines.id, slotId: folioLines.slotId, zoneId: folioLines.zoneId, quantity: folioLines.quantity })
    .from(folioLines)
    .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org), isNull(folioLines.cancelledAt)))
  // 3. The batch. `cancelledHere` holds only once the first statement took effect; a line's own
  //    gate, only once the second statement cancelled that line.
  const cancelledHere = sql`EXISTS (SELECT 1 FROM folios g
    WHERE g.id = ${folioId} AND g.organization_id = ${org}
      AND g.cancelled_at = ${atSec} AND g.cancellation_source = 'payment_not_received')`
  const lineCancelledHere = (lineId: string) => sql`EXISTS (SELECT 1 FROM folio_lines gl
    WHERE gl.id = ${lineId} AND gl.organization_id = ${org}
      AND gl.cancelled_at = ${atSec} AND gl.cancellation_source = 'payment_not_received')`

  const cancelSale = db
    .update(folios)
    .set({
      cancelledAt: at,
      cancelledBy: null,
      cancellationSource: 'payment_not_received',
      cancellationReason: PAYMENT_NOT_RECEIVED_REASON,
      // The sale was void: the seller loses the commission, as with Rechazar.
      cancellationClawback: true,
      updatedAt: at,
    })
    .where(
      and(
        eq(folios.id, folioId),
        eq(folios.organizationId, org),
        isNull(folios.cancelledAt),
        rowStillPending,
        noOtherMoney,
        noPaymentUndecided,
      ),
    )
    .returning({ id: folios.id })

  const statements: BatchItem<'sqlite'>[] = [
    db
      .update(folioLines)
      .set({ cancelledAt: at, cancelledBy: null, cancellationSource: 'payment_not_received' })
      .where(
        and(
          eq(folioLines.folioId, folioId),
          eq(folioLines.organizationId, org),
          isNull(folioLines.cancelledAt),
          cancelledHere,
        ),
      ),
    // The money that never arrived leaves the sales bucket, and the commission is clawed back.
    ...(await buildCancellationReversal(db, {
      organizationId: org,
      folioId,
      collectedBy: sale.agentId,
      at,
      clawback: true,
      gate: cancelledHere,
    })),
    ...buildInventoryReleaseStatements(db, {
      organizationId: org,
      folioId,
      at,
      gate: cancelledHere,
      lines: liveLines.map((l) => ({ ...l, gate: lineCancelledHere(l.id) })),
    }),
    // D13 — the sale's other links stop taking money; the claimed one already ended `expired`.
    markLinksClosingStatement(db, org, folioId, 'cancelled', { at, gate: cancelledHere }),
    folioEventRowWhere(
      db,
      {
        organizationId: org,
        folioId,
        type: 'transfer_not_received',
        actorId: null,
        payload: { link_id: link.id, kind: link.kind },
        at,
      },
      cancelledHere,
    ),
  ]
  const [won] = await db.batch([cancelSale, ...statements])
  // Nothing matched: something changed after step 2 — another cancellation, a verification, money
  // or a payment. The sale is left as it is.
  if (won.length === 0) return 'kept'

  // 4. After the batch. The message is the one Rechazar sends (its copy fixed by defect 11).
  await emitNotification(db, {
    organizationId: org,
    folioId,
    event: 'payment_rejected',
    hasEmail: !!sale.customerEmail,
  })
  deps.waitUntil(
    (async () => {
      await closePaymentLinkRemote(deps, link)
      await closeOpenLinksAfterWrite(deps, org, folioId)
    })(),
  )
  return 'cancelled'
}
