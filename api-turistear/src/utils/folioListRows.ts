// US-A82/US-AG49 (docs/oversight/folio-list-scanability.spec.md) — the two decorations a folio LIST
// row needs beyond the folio table itself: its lines (so the card can name what was sold, and so the
// WhatsApp template can render {itinerary} without a second request — D14) and its portal link (so
// the ticket send can happen from the list at all).
//
// Both are fetched by RE-APPLYING the caller's own WHERE filters through a join, never by collecting
// the returned ids into an `IN (...)`. D1 caps bound parameters per query, and this list is
// deliberately unpaginated (TECH_DEBT #23) — an id list would blow that cap on exactly the
// organizations the feature exists to serve.

import { and, asc, eq, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import { folioRequests, folioAccessTokens, folioLines, folios } from '../db/schema'
import { lineFulfillment, type Fulfillment } from './folioFulfillment'

/** The lean line shape the card and `renderItinerary()` share (spec D14). */
export interface FolioListLine {
  id: string
  service_name: string
  line_type: 'slot' | 'stay'
  slot_date: string | null
  slot_start_time: string | null
  check_in: string | null
  check_out: string | null
  guests: number | null
  quantity: number
  // US-A85 — the two counts the fulfilment axis is DERIVED from. Carried on the line rather than
  // rolled up server-side into a single number, so the same row can answer "how many boarded" and
  // "which line was it" without a second read (D2: fulfilment lives on the line).
  redeemed_count: number
  fulfillment: Fulfillment
  /** US-A89 (D14) — the line's own money state for the card's per-line marks. Absent when the
   * line has no allocations (legacy fixture) — the card simply shows no mark. */
  money_state?: 'paid' | 'booking' | 'cancelled'
}

/**
 * Lines for every folio matching `filters`, grouped by folio id and ordered by `created_at` ASC —
 * so "the first line" is the same line the detail page shows (business rule 2).
 *
 * `filters` are the caller's folio-level predicates (already org-scoped); `folio_lines` is scoped to
 * the org a second time, matching the double scope `readFolio` applies.
 */
export const readListLines = async (
  db: Db,
  org: string,
  filters: SQL[],
  /** US-A85 — the org's clock and no-show margin, so each line can carry its own reading. */
  fulfillmentCtx: { tz: string; marginMinutes: number; nowEpoch: number },
): Promise<Map<string, FolioListLine[]>> => {
  const rows = await db
    .select({
      id: folioLines.id,
      folioId: folioLines.folioId,
      serviceName: folioLines.serviceName,
      lineType: folioLines.lineType,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      checkIn: folioLines.checkIn,
      checkOut: folioLines.checkOut,
      guests: folioLines.guests,
      quantity: folioLines.quantity,
      redeemedCount: folioLines.redeemedCount,
      // US-A89 — cancellation is a written stamp; money derives from allocations (NULL = none).
      cancelledAt: folioLines.cancelledAt,
      lineTotal: folioLines.lineTotal,
      allocated: sql<number | null>`(select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = folio_lines.id)`,
    })
    .from(folioLines)
    .innerJoin(folios, eq(folioLines.folioId, folios.id))
    .where(and(eq(folioLines.organizationId, org), ...filters))
    .orderBy(asc(folioLines.createdAt))

  const byFolio = new Map<string, FolioListLine[]>()
  for (const r of rows) {
    const list = byFolio.get(r.folioId) ?? []
    list.push({
      id: r.id,
      service_name: r.serviceName,
      line_type: r.lineType,
      slot_date: r.slotDate,
      slot_start_time: r.slotStartTime,
      check_in: r.checkIn,
      check_out: r.checkOut,
      guests: r.guests,
      quantity: r.quantity,
      redeemed_count: r.redeemedCount,
      // US-A89 (D14) — the per-line mark: cancelled from its stamp, else money from allocations.
      money_state: r.cancelledAt
        ? ('cancelled' as const)
        : r.allocated === null
          ? undefined
          : Math.max(0, Number(r.allocated)) >= r.lineTotal
            ? ('paid' as const)
            : ('booking' as const),
      fulfillment: lineFulfillment(
        {
          lineId: r.id,
          lineType: r.lineType,
          slotDate: r.slotDate,
          slotStartTime: r.slotStartTime,
          checkIn: r.checkIn,
          lineTotal: 0, // unused by the reading; the ladder is the only thing that prices
          quantity: r.quantity,
          redeemedCount: r.redeemedCount,
        },
        fulfillmentCtx.tz,
        fulfillmentCtx.marginMinutes,
        fulfillmentCtx.nowEpoch,
      ),
    })
    byFolio.set(r.folioId, list)
  }
  return byFolio
}

/**
 * The NEWEST portal token per folio, rendered as the same URL `readFolio` builds. Empty map when no
 * base URL is configured — the caller then serializes `portal_link: null`, exactly as the detail
 * endpoint does (business rule 3).
 */
export const readListPortalLinks = async (
  db: Db,
  org: string,
  filters: SQL[],
  apiBaseUrl: string | undefined,
): Promise<Map<string, string>> => {
  if (!apiBaseUrl) return new Map()

  const rows = await db
    .select({ folioId: folioAccessTokens.folioId, token: folioAccessTokens.token })
    .from(folioAccessTokens)
    .innerJoin(folios, eq(folioAccessTokens.folioId, folios.id))
    .where(and(eq(folioAccessTokens.organizationId, org), ...filters))
    // ASC + overwrite ⇒ the last write per folio is the newest token, matching readFolio's
    // `orderBy(desc(createdAt)).limit(1)` without needing a window function per folio.
    .orderBy(asc(folioAccessTokens.createdAt))

  const byFolio = new Map<string, string>()
  for (const r of rows) byFolio.set(r.folioId, `${apiBaseUrl}/portal/${r.token}`)
  return byFolio
}

/** US-A84 rule 6 — what a folio's cancellation requests amount to, for the row. */
export type CancellationRequestMark = 'pending' | 'resolved'

/**
 * The cancellation-request mark per folio (US-A84 rule 6): `'pending'` when ANY request is still
 * pending, `'resolved'` when the folio has requests but none pending, absent when it has none.
 *
 * `'pending'` wins regardless of row order — a folio can hold a rejected request and a live one at
 * the same time, and the live one is the whole reason this field exists. Same double org scope and
 * same filter-through-join as the two decorations above: never an `IN (...)` of returned ids.
 */
export const readListCancellationRequests = async (
  db: Db,
  org: string,
  filters: SQL[],
): Promise<Map<string, CancellationRequestMark>> => {
  const rows = await db
    .select({ folioId: folioRequests.folioId, status: folioRequests.status })
    .from(folioRequests)
    .innerJoin(folios, eq(folioRequests.folioId, folios.id))
    .where(and(eq(folioRequests.organizationId, org), ...filters))

  const byFolio = new Map<string, CancellationRequestMark>()
  for (const r of rows) {
    if (r.status === 'pending') byFolio.set(r.folioId, 'pending')
    else if (!byFolio.has(r.folioId)) byFolio.set(r.folioId, 'resolved')
  }
  return byFolio
}
