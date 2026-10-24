import type { Context } from 'hono'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { devoladaLinks, devoladaPayments, folios } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { readFolioDetail } from '../../utils/folioDetail'
import { confirmedToReturnSql, IN_FLIGHT_STATUSES } from '../../utils/devoladaSql'
import { applySettlement, planSettlement, type SettlementPlan } from '../pos/settleCore'
import { closePaymentLinkRemote } from './links'
import type { ResolveDevoladaPaymentInput } from './schema'

// devolada-transfer-verification D15 — `POST /api/devolada/payments/:id/resolve`. Every action is
// claimed by a guarded write before it acts, so a double tap answers 409 the second time and
// writes nothing:
// - `accept`: a settlement payment that ended `partial` or `invalid`, or is still in flight, is
//   recorded as the admin's — D8's claimed batch, which also sets the resolution;
// - `dismiss`: a settlement exception, or a settlement payment in flight on a link no credential
//   can read (D21), is set aside: the apartado continues;
// - `returned`: the admin returned money that settled nothing — an `unapplied` payment, or a
//   `confirmed` one that reached a cancelled sale or a link a write had closed (D9, D13).
//
// The note is validated (≤ 500 characters) and not stored: the data model has no place for it yet.

const IN_FLIGHT: ReadonlySet<string> = new Set(IN_FLIGHT_STATUSES)

export type DevoladaContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

const notResolvable = () =>
  new ApiError('DEVOLADA_PAYMENT_NOT_RESOLVABLE', 409, 'This payment cannot be resolved this way now')

export const resolveDevoladaPayment = async (c: DevoladaContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id') ?? ''
  const { action } = (await c.req.json()) as ResolveDevoladaPaymentInput
  const db = getDb(c.env)

  // Another organization's payment is unknown here (constitution III).
  const [found] = await db
    .select({ payment: devoladaPayments, link: devoladaLinks, cancelledAt: folios.cancelledAt })
    .from(devoladaPayments)
    .innerJoin(
      devoladaLinks,
      and(eq(devoladaLinks.id, devoladaPayments.linkId), eq(devoladaLinks.organizationId, devoladaPayments.organizationId)),
    )
    .innerJoin(folios, and(eq(folios.id, devoladaPayments.folioId), eq(folios.organizationId, devoladaPayments.organizationId)))
    .where(and(eq(devoladaPayments.id, id), eq(devoladaPayments.organizationId, org)))
    .limit(1)
  if (!found) throw new ApiError('NOT_FOUND', 404, 'Payment not found')
  const { payment } = found
  const now = new Date()

  switch (action) {
    case 'returned': {
      // Confirmed money is to return only when it settled nothing: its link never ended `paid`, and
      // the sale was cancelled or a write closed the link first (D9, D13).
      const owesBack =
        payment.status === 'unapplied' ||
        (payment.status === 'confirmed' &&
          found.link.state !== 'paid' &&
          (found.cancelledAt !== null || found.link.closedReason !== null))
      if (!owesBack || payment.resolution !== null) throw notResolvable()
      const confirmedToReturn = sql`EXISTS (SELECT 1 FROM devolada_links rl
        WHERE rl.id = ${payment.linkId} AND rl.organization_id = ${org}
          AND ${confirmedToReturnSql('devolada_payments', 'rl')})`
      const [claimed] = await db
        .update(devoladaPayments)
        .set({ resolution: 'returned', resolvedBy: admin.userId, resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(devoladaPayments.id, payment.id),
            eq(devoladaPayments.organizationId, org),
            isNull(devoladaPayments.resolution),
            or(
              eq(devoladaPayments.status, 'unapplied'),
              and(eq(devoladaPayments.status, 'confirmed'), confirmedToReturn),
            ),
          ),
        )
        .returning({ id: devoladaPayments.id })
      if (!claimed) throw notResolvable()
      break
    }
    case 'accept': {
      const exception = payment.status === 'partial' || payment.status === 'invalid'
      if (found.link.kind !== 'settlement' || payment.resolution !== null || !(exception || IN_FLIGHT.has(payment.status))) {
        throw notResolvable()
      }
      if (found.cancelledAt) throw new ApiError('FOLIO_CANCELLED', 409, 'Folio is cancelled')
      let plan: SettlementPlan
      try {
        // A payment submitted before its link expired is recorded past the apartado's clock (D8).
        plan = await planSettlement(
          db,
          { organizationId: org, folioId: payment.folioId, folioLineId: found.link.folioLineId },
          { now, bypassExpiry: payment.devoladaCreatedAt.getTime() < found.link.expiresAt.getTime() },
        )
      } catch (err) {
        if (err instanceof ApiError && err.code === 'FOLIO_CANCELLED') throw err
        // Settled another way while the payment waited: nothing is owed; dismiss is the way out.
        if (err instanceof ApiError) throw notResolvable()
        throw err
      }
      const { recorded } = await applySettlement(
        { db, env: c.env, waitUntil: (p) => c.executionCtx.waitUntil(p) },
        plan,
        {
          method: 'transfer',
          reference: payment.receiptNumber,
          verification: 'verified',
          verifiedBy: admin.userId,
          verifiedAt: now,
          collectedBy: found.link.requestedBy,
          settledBy: admin.userId,
          actorId: admin.userId,
          at: now,
          recordedAt: now,
          // A payment in flight keeps its link open: its verdict records nothing more and ends it.
          claim: { linkId: found.link.id, markPaid: false, resolve: { devoladaPaymentId: payment.id, resolvedBy: admin.userId } },
        },
      )
      if (!recorded) throw notResolvable()
      break
    }
    case 'dismiss': {
      // Closing a link under a payment in flight would turn it `unapplied` (D13): only a link no
      // credential can read, which cannot be closed anyway, lets its payment be dismissed (D21).
      const exception = payment.status === 'partial' || payment.status === 'invalid'
      const unreadable = found.link.state === 'failed' && IN_FLIGHT.has(payment.status)
      if (found.link.kind !== 'settlement' || payment.resolution !== null || !(exception || unreadable)) {
        throw notResolvable()
      }
      const [claimed] = await db
        .update(devoladaPayments)
        .set({ resolution: 'dismissed', resolvedBy: admin.userId, resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(devoladaPayments.id, payment.id),
            eq(devoladaPayments.organizationId, org),
            isNull(devoladaPayments.resolution),
            inArray(devoladaPayments.status, exception ? ['partial', 'invalid'] : [...IN_FLIGHT_STATUSES]),
          ),
        )
        .returning({ id: devoladaPayments.id })
      if (!claimed) throw notResolvable()
      // The link closes where a credential can still reach it; fail-soft, the sweep retries.
      if (found.link.state !== 'failed') {
        await db
          .update(devoladaLinks)
          .set({ state: 'closing', updatedAt: now })
          .where(and(eq(devoladaLinks.id, found.link.id), eq(devoladaLinks.organizationId, org), eq(devoladaLinks.state, 'open')))
        c.executionCtx.waitUntil(closePaymentLinkRemote({ db, env: c.env }, found.link))
      }
      break
    }
  }

  const folio = await readFolioDetail(db, org, payment.folioId, { apiBaseUrl: c.env.API_BASE_URL })
  return c.json({ folio })
}
