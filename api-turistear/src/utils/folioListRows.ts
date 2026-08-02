// US-A82/US-AG49 (docs/oversight/folio-list-scanability.spec.md) — the two decorations a folio LIST
// row needs beyond the folio table itself: its lines (so the card can name what was sold, and so the
// WhatsApp template can render {itinerary} without a second request — D14) and its portal link (so
// the ticket send can happen from the list at all).
//
// Both are fetched by RE-APPLYING the caller's own WHERE filters through a join, never by collecting
// the returned ids into an `IN (...)`. D1 caps bound parameters per query, and this list is
// deliberately unpaginated (TECH_DEBT #23) — an id list would blow that cap on exactly the
// organizations the feature exists to serve.

import { and, asc, eq, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import { folioAccessTokens, folioLines, folios } from '../db/schema'

/** The lean line shape the card and `renderItinerary()` share (spec D14). */
export interface FolioListLine {
  service_name: string
  line_type: 'slot' | 'stay'
  slot_date: string | null
  slot_start_time: string | null
  check_in: string | null
  check_out: string | null
  guests: number | null
  quantity: number
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
): Promise<Map<string, FolioListLine[]>> => {
  const rows = await db
    .select({
      folioId: folioLines.folioId,
      serviceName: folioLines.serviceName,
      lineType: folioLines.lineType,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      checkIn: folioLines.checkIn,
      checkOut: folioLines.checkOut,
      guests: folioLines.guests,
      quantity: folioLines.quantity,
    })
    .from(folioLines)
    .innerJoin(folios, eq(folioLines.folioId, folios.id))
    .where(and(eq(folioLines.organizationId, org), ...filters))
    .orderBy(asc(folioLines.createdAt))

  const byFolio = new Map<string, FolioListLine[]>()
  for (const r of rows) {
    const list = byFolio.get(r.folioId) ?? []
    list.push({
      service_name: r.serviceName,
      line_type: r.lineType,
      slot_date: r.slotDate,
      slot_start_time: r.slotStartTime,
      check_in: r.checkIn,
      check_out: r.checkOut,
      guests: r.guests,
      quantity: r.quantity,
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
