import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  devoladaLinks,
  devoladaPayments,
  folios,
  type DevoladaLink,
  type DevoladaPayment,
} from '../db/schema'

// devolada-transfer-verification D14 — the read model of the payment links on a sale.
//
// The server decides each link's `label` (contracts/turistear-api.md § Labels); the client only maps
// the code to copy and an icon. A label decided in the client would be a second source of truth
// (constitution IV).

export type PaymentLinkLabel =
  | 'link_failed'
  | 'confirmed'
  | 'unapplied'
  | 'partial'
  | 'invalid'
  | 'not_received'
  | 'closed'
  | 'credit_paused'
  | 'needs_tracking_key'
  | 'validating'
  | 'awaiting_payment'

export interface PaymentLinkPaymentView {
  id: string
  status: DevoladaPayment['status']
  asked: number
  claimed: number | null
  received: number | null
  match: DevoladaPayment['match']
  receipt_number: string | null
  verdict_at: number | null
  awaiting: DevoladaPayment['awaiting']
  awaiting_reason: DevoladaPayment['awaitingReason']
  resolution: DevoladaPayment['resolution']
}

export interface PaymentLinkView {
  id: string
  kind: DevoladaLink['kind']
  folio_line_id: string | null
  state: DevoladaLink['state']
  amount: number
  url: string | null
  expires_at: number
  closed_reason: DevoladaLink['closedReason']
  label: PaymentLinkLabel
  payment: PaymentLinkPaymentView | null
}

type LabelLink = Pick<DevoladaLink, 'state'> & { closedReason?: DevoladaLink['closedReason'] }
type LabelPayment = Pick<DevoladaPayment, 'status' | 'awaiting'>

/**
 * The precedence table of contracts/turistear-api.md § Labels: the first row that matches wins.
 * `currentPayment` is the link's latest non-superseded payment, or null before the customer
 * submits proof.
 */
export function deriveLinkLabel(
  link: LabelLink,
  currentPayment: LabelPayment | null,
  saleCancelled: boolean,
): PaymentLinkLabel {
  const p = currentPayment
  if (link.state === 'failed' || link.state === 'abandoned' || link.state === 'creating') return 'link_failed'
  // A cancelled sale is never verified, and a link a write closed (D13) no longer collects what the
  // sale owes: confirmed money that arrives on either is money to return (D9). A `paid` link's money
  // was applied before: the sale was cancelled later, and its cancellation priced that money.
  if (p?.status === 'confirmed' && (link.state === 'paid' || (!saleCancelled && !link.closedReason))) return 'confirmed'
  if (p?.status === 'unapplied' || p?.status === 'confirmed') return 'unapplied'
  if (p?.status === 'partial') return 'partial'
  if (p?.status === 'invalid') return 'invalid'
  if (p?.status === 'expired' || link.state === 'expired') return 'not_received'
  if ((link.state === 'closing' || link.state === 'closed') && !p) return 'closed'
  if (p?.status === 'queued_for_credit') return 'credit_paused'
  if (p?.status === 'validating' && p.awaiting) return 'needs_tracking_key'
  if (p?.status === 'validating') return 'validating'
  if (link.state === 'open' && !p) return 'awaiting_payment'
  // Unreachable for a consistent row (a `paid` link has its confirmed payment); a closed link with
  // a payment that ended is closed above or by its verdict's own row.
  return 'closed'
}

const IN_FLIGHT: ReadonlySet<DevoladaPayment['status']> = new Set(['validating', 'queued_for_credit'])

/** data-model § devolada_links: something may still happen to the link at Devolada. */
export const isUnresolvedLink = (
  link: Pick<DevoladaLink, 'state'>,
  currentPayment: Pick<DevoladaPayment, 'status'> | null,
): boolean =>
  link.state === 'creating' ||
  link.state === 'open' ||
  link.state === 'closing' ||
  link.state === 'abandoned' ||
  (link.state === 'closed' && !!currentPayment && IN_FLIGHT.has(currentPayment.status))

const sec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null)

/** The link's current payment: its latest non-superseded one by Devolada's own creation time. */
export const currentPaymentOf = <P extends Pick<DevoladaPayment, 'status' | 'devoladaCreatedAt'>>(
  payments: P[],
): P | null => {
  let current: P | null = null
  for (const p of payments) {
    if (p.status === 'superseded') continue
    // `>=` so that, at an equal instant, the row written last (iterated last) wins.
    if (!current || p.devoladaCreatedAt.getTime() >= current.devoladaCreatedAt.getTime()) current = p
  }
  return current
}

export const toPaymentLinkView = (
  link: DevoladaLink,
  payments: DevoladaPayment[],
  saleCancelled: boolean,
): PaymentLinkView => {
  const p = currentPaymentOf(payments)
  return {
    id: link.id,
    kind: link.kind,
    folio_line_id: link.folioLineId,
    state: link.state,
    amount: link.amount,
    url: link.url,
    expires_at: sec(link.expiresAt)!,
    closed_reason: link.closedReason,
    label: deriveLinkLabel(link, p, saleCancelled),
    payment: p
      ? {
          id: p.id,
          status: p.status,
          asked: p.askedAmount,
          claimed: p.claimedAmount,
          received: p.receivedAmount,
          match: p.match,
          receipt_number: p.receiptNumber,
          verdict_at: sec(p.verdictAt),
          awaiting: p.awaiting,
          awaiting_reason: p.awaitingReason,
          resolution: p.resolution,
        }
      : null,
  }
}

/**
 * Which sales to read: a handful of ids (a detail, a checkout answer), or the caller's own folio
 * filters re-applied through a join. Lists use the filters, never an id list: D1 caps bound
 * parameters and the folio lists are unbounded (utils/folioListRows.ts).
 */
export type LinkViewScope = { folioIds: string[] } | { filters: SQL[] }

const folioScope = (
  organizationId: string,
  scope: LinkViewScope,
  folioIdColumn: typeof devoladaLinks.folioId | typeof devoladaPayments.folioId,
): (SQL | undefined)[] =>
  'folioIds' in scope
    ? [inArray(folioIdColumn, scope.folioIds), eq(folios.organizationId, organizationId)]
    : scope.filters

/** The scoped sales' links, newest first; the rowid keeps two links of one second in write order. */
export const paymentLinkRowsQuery = (db: Db, organizationId: string, scope: LinkViewScope) =>
  db
    .select({ link: devoladaLinks, cancelledAt: folios.cancelledAt })
    .from(devoladaLinks)
    .innerJoin(folios, eq(folios.id, devoladaLinks.folioId))
    .where(
      and(eq(devoladaLinks.organizationId, organizationId), ...folioScope(organizationId, scope, devoladaLinks.folioId)),
    )
    .orderBy(sql`${devoladaLinks.createdAt} desc`, sql`devolada_links.rowid desc`)

/** The scoped sales' Devolada payments, oldest first, for `currentPaymentOf`. */
export const linkPaymentRowsQuery = (db: Db, organizationId: string, scope: LinkViewScope) =>
  db
    .select({ payment: devoladaPayments })
    .from(devoladaPayments)
    .innerJoin(folios, eq(folios.id, devoladaPayments.folioId))
    .where(
      and(
        eq(devoladaPayments.organizationId, organizationId),
        ...folioScope(organizationId, scope, devoladaPayments.folioId),
      ),
    )
    .orderBy(asc(devoladaPayments.devoladaCreatedAt), sql`devolada_payments.rowid asc`)

/**
 * Every payment link of the scoped sales, newest first, as the contract's `PaymentLinkView`. One
 * query for the links and one for their payments, both scoped by organization and backed by the
 * `(organization_id, folio_id)` indexes — never a correlated subquery per row.
 */
export async function loadPaymentLinkViews(
  db: Db,
  organizationId: string,
  scope: LinkViewScope,
): Promise<Map<string, PaymentLinkView[]>> {
  const out = new Map<string, PaymentLinkView[]>()
  if ('folioIds' in scope && scope.folioIds.length === 0) return out

  const linkRows = await paymentLinkRowsQuery(db, organizationId, scope)
  if (linkRows.length === 0) return out
  const paymentRows = await linkPaymentRowsQuery(db, organizationId, scope)

  const paymentsByLink = new Map<string, DevoladaPayment[]>()
  for (const { payment } of paymentRows) {
    const list = paymentsByLink.get(payment.linkId) ?? []
    list.push(payment)
    paymentsByLink.set(payment.linkId, list)
  }
  for (const { link, cancelledAt } of linkRows) {
    const list = out.get(link.folioId) ?? []
    list.push(toPaymentLinkView(link, paymentsByLink.get(link.id) ?? [], cancelledAt !== null))
    out.set(link.folioId, list)
  }
  return out
}

/** A list row's link: the latest unresolved one, otherwise the latest, otherwise none (D14). */
export const listRowPaymentLink = (views: PaymentLinkView[] | undefined): PaymentLinkView | null => {
  if (!views?.length) return null
  return (
    views.find((v) =>
      isUnresolvedLink({ state: v.state }, v.payment ? { status: v.payment.status } : null),
    ) ?? views[0]!
  )
}
