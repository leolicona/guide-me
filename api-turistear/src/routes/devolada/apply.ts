import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import {
  devoladaConnections,
  devoladaLinks,
  devoladaPayments,
  folios,
  type DevoladaLink,
  type DevoladaPayment,
  type DevoladaPaymentStatus,
} from '../../db/schema'
import type { DevoladaPaymentRead } from '../../services/devolada'
import { deriveStatusSql } from '../../utils/folioStatus'
import { releaseClearedFolio, verifyFolioPayment } from '../pos/verifyCore'
import { setCreditPaused } from './connection'

// devolada-transfer-verification D9 — applying what Devolada reports for a payment. The webhook and
// the sweep share this one function, and both call it with a RE-READ, never with a webhook body.
//
// Applying twice changes nothing, and a final status never goes back. `applied_status` lets a
// repeat return early, but that read is only an optimization: the guarantee is the guarded write
// each branch makes (D10's flip and rollup).
//
// This is PR 1 (research D19): `validating`, `queued_for_credit` and an `awaiting` wait are
// snapshots, and `confirmed` on a `sale` link verifies that payment row and releases the tickets.
// Every other status, and every other kind of link, is only recorded — WITHOUT marking it applied,
// so the PR that handles it applies it then: a later PR's preview writes deposit and settlement
// links into dev's database while dev still runs this code.

export interface ApplyDeps {
  db: Db
  env: CloudflareBindings
  waitUntil: (promise: Promise<unknown>) => void
}

const FINAL: ReadonlySet<DevoladaPaymentStatus> = new Set([
  'confirmed',
  'partial',
  'unapplied',
  'invalid',
  'expired',
  'superseded',
])

const toDate = (sec: number | null): Date | null => (sec === null ? null : new Date(sec * 1000))

/**
 * Stores Devolada's latest word on a payment. A final status is never overwritten by another
 * status: Devolada promises a verdict is final, and an older re-read must not undo it.
 */
async function upsertSnapshot(
  db: Db,
  link: DevoladaLink,
  payment: DevoladaPaymentRead,
  now: Date,
): Promise<{ stored: DevoladaPayment; previousStatus: DevoladaPaymentStatus | null }> {
  const existing = (
    await db
      .select()
      .from(devoladaPayments)
      .where(
        and(
          eq(devoladaPayments.devoladaPaymentId, payment.id),
          eq(devoladaPayments.organizationId, link.organizationId),
        ),
      )
      .limit(1)
  )[0]
  const snapshot = {
    status: payment.status,
    proofDoor: payment.proofDoor,
    askedAmount: payment.askedCents,
    claimedAmount: payment.claimedCents,
    receivedAmount: payment.receivedCents,
    match: payment.match,
    receiptNumber: payment.receiptNumber,
    verdictAt: toDate(payment.confirmedAt),
    awaiting: payment.awaiting,
    awaitingReason: payment.awaitingReason,
    updatedAt: now,
  }
  if (!existing) {
    const [inserted] = await db
      .insert(devoladaPayments)
      .values({
        id: crypto.randomUUID(),
        organizationId: link.organizationId,
        linkId: link.id,
        folioId: link.folioId,
        devoladaPaymentId: payment.id,
        devoladaCreatedAt: new Date(payment.createdAt * 1000),
        createdAt: now,
        ...snapshot,
      })
      // Two processors at once (the webhook and the sweep): the second one reads the first's row.
      .onConflictDoNothing({ target: devoladaPayments.devoladaPaymentId })
      .returning()
    if (inserted) return { stored: inserted, previousStatus: null }
    return upsertSnapshot(db, link, payment, now)
  }
  if (FINAL.has(existing.status) && existing.status !== payment.status) {
    return { stored: existing, previousStatus: existing.status }
  }
  const [updated] = await db
    .update(devoladaPayments)
    .set(snapshot)
    .where(and(eq(devoladaPayments.id, existing.id), eq(devoladaPayments.organizationId, link.organizationId)))
    .returning()
  return { stored: updated ?? existing, previousStatus: existing.status }
}

const markApplied = (db: Db, row: DevoladaPayment, now: Date) =>
  db
    .update(devoladaPayments)
    .set({ appliedStatus: row.status, appliedAt: now })
    .where(and(eq(devoladaPayments.id, row.id), eq(devoladaPayments.organizationId, row.organizationId)))

/**
 * D9 — applies one re-read payment of one of our links. Answers whether a branch acted
 * (`applied`), or the payment was only recorded or already applied (`no_change`).
 */
export async function applyDevoladaPayment(
  deps: ApplyDeps,
  { link, payment }: { link: DevoladaLink; payment: DevoladaPaymentRead },
): Promise<'applied' | 'no_change'> {
  const { db } = deps
  const org = link.organizationId
  const now = new Date()
  const { stored, previousStatus } = await upsertSnapshot(db, link, payment, now)

  // Every notification applied, and every successful re-read, stamps the link: the sweep spends
  // its budget only on links nothing has reported on for 10 minutes (D12).
  await db
    .update(devoladaLinks)
    .set({ lastCheckedAt: now })
    .where(and(eq(devoladaLinks.id, link.id), eq(devoladaLinks.organizationId, org)))

  // A payment stored as queued_for_credit that moves on — a final verdict included, since a
  // re-read may never show the `validating` in between — means the credit is flowing again.
  if (previousStatus === 'queued_for_credit' && stored.status !== 'queued_for_credit') {
    await setCreditPaused(db, org, false)
  }

  if (stored.appliedStatus === stored.status) return 'no_change'

  switch (stored.status) {
    case 'validating':
    case 'queued_for_credit': {
      // A snapshot is the whole action: the sale shows «Verificando pago», «Verificación en pausa»
      // or «Pide al cliente su clave de rastreo». Paused credit is the CURRENT business's: a retired
      // credential's link leaves the connection's health alone (D21).
      if (stored.status === 'queued_for_credit') {
        const current = (
          await db
            .select({ id: devoladaConnections.currentCredentialId })
            .from(devoladaConnections)
            .where(eq(devoladaConnections.organizationId, org))
            .limit(1)
        )[0]
        if (current?.id === link.credentialId) await setCreditPaused(db, org, true)
      }
      await markApplied(db, stored, now)
      return 'applied'
    }
    case 'confirmed': {
      // PR 1 applies a sale link only; deposits and settlements come with PR 2 (D19).
      if (link.kind !== 'sale' || !link.folioPaymentId) return 'no_change'
      const sale = (
        await db
          .select({ cancelledAt: folios.cancelledAt, status: deriveStatusSql })
          .from(folios)
          .where(and(eq(folios.id, link.folioId), eq(folios.organizationId, org)))
          .limit(1)
      )[0]
      // A cancelled sale is never verified: its money is to be returned, which PR 2 brings (D9).
      if (!sale || sale.cancelledAt) return 'no_change'
      return applyConfirmedSale(deps, link, stored, sale.status, now)
    }
    default:
      return 'no_change'
  }
}

/** D9, D10 — a confirmed transfer of a sale link: verify THAT row, release once, close the link. */
async function applyConfirmedSale(
  deps: ApplyDeps,
  link: DevoladaLink,
  stored: DevoladaPayment,
  saleStatus: 'paid' | 'booking' | 'cancelled',
  now: Date,
): Promise<'applied'> {
  const { db } = deps
  const org = link.organizationId
  const verdictAt = stored.verdictAt ?? now
  const receipt = stored.receiptNumber ?? undefined
  // 1. One row, «Sistema» as the actor. It matches nothing if an admin already verified it by
  //    hand, so nothing is released twice (D10).
  const { flipped, rollupVerified } = await verifyFolioPayment(
    { db },
    {
      organizationId: org,
      folioId: link.folioId,
      paymentId: link.folioPaymentId!,
      actorId: null,
      reference: receipt,
      at: verdictAt,
      refuseCancelled: true,
      eventPayload: { source: 'devolada', receipt_number: stored.receiptNumber, received: stored.receivedAmount },
    },
  )
  // 2. The tickets, only in the call whose own flip and rollup both matched, for a paid sale.
  if (flipped && rollupVerified && saleStatus === 'paid') {
    await releaseClearedFolio(deps, { organizationId: org, folioId: link.folioId, at: verdictAt })
  }
  // 3-5. The receipt number becomes the sale's reference, the link is paid, and the connection
  //      records its last verdict (FR-005).
  await db.batch([
    db
      .update(folios)
      .set({ paymentReference: stored.receiptNumber, updatedAt: now })
      .where(
        and(eq(folios.id, link.folioId), eq(folios.organizationId, org), sql`${folios.cancelledAt} IS NULL`),
      ),
    db
      .update(devoladaLinks)
      .set({ state: 'paid', updatedAt: now })
      .where(
        and(
          eq(devoladaLinks.id, link.id),
          eq(devoladaLinks.organizationId, org),
          inArray(devoladaLinks.state, ['open', 'closing', 'closed']),
        ),
      ),
    db
      .update(devoladaConnections)
      .set({ lastVerdictAt: now, updatedAt: now })
      .where(eq(devoladaConnections.organizationId, org)),
    markApplied(db, stored, now),
  ])
  return 'applied'
}
