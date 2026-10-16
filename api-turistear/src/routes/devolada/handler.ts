import type { Context } from 'hono'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { devoladaLinks, devoladaPayments, folios } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import { readFolioDetail } from '../../utils/folioDetail'
import type { ResolveDevoladaPaymentInput } from './schema'

// devolada-transfer-verification D15 — `POST /api/devolada/payments/:id/resolve`. Every action is
// claimed by a guarded write before it acts, so a double tap answers 409 the second time and
// writes nothing:
// - `returned`: the admin returned money that settled nothing — an `unapplied` payment, or a
//   `confirmed` one on a cancelled sale, which a cancelled sale never keeps (D9);
// - `accept` and `dismiss`: a settlement's exception, with Story 3 (T062).
//
// The note is validated (≤ 500 characters) and not stored: the data model has no place for it yet.

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
      const owesBack = payment.status === 'unapplied' || (payment.status === 'confirmed' && found.cancelledAt !== null)
      if (!owesBack || payment.resolution !== null) throw notResolvable()
      const saleCancelled = sql`EXISTS (SELECT 1 FROM folios fc
        WHERE fc.id = ${payment.folioId} AND fc.organization_id = ${org} AND fc.cancelled_at IS NOT NULL)`
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
              and(eq(devoladaPayments.status, 'confirmed'), saleCancelled),
            ),
          ),
        )
        .returning({ id: devoladaPayments.id })
      if (!claimed) throw notResolvable()
      break
    }
    case 'accept':
    case 'dismiss':
      // A settlement's exception: Story 3 (T062).
      throw notResolvable()
  }

  const folio = await readFolioDetail(db, org, payment.folioId, { apiBaseUrl: c.env.API_BASE_URL })
  return c.json({ folio })
}
