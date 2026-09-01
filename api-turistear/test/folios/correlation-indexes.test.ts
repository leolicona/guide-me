import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../../src/db/client'
import { folios, folioLines, users, affiliateOperators } from '../../src/db/schema'
import {
  anyLineStatusSql,
  deriveBookingExpiresAtSql,
  deriveRefundAmountSql,
  deriveRefundStatusSql,
  deriveStatusSql,
} from '../../src/utils/folioStatus'
import { refundPendingFilter } from '../../src/utils/folioPendingWork'
import { displayMethodSql } from '../../src/utils/folioPayments'

// BUG-042 (docs/BUGS.md). Every folio roll-up is a correlated subquery over `folio_lines` (and,
// inside it, over `folio_payment_allocations`) keyed by the CHILD column alone — `fl.folio_id =
// folios.id`, `a.folio_line_id = fl.id`. The only indexes those tables had led with
// `organization_id`, which the correlation never names, so SQLite scanned both tables in full
// once per folio of the list. Migration 0067 adds the single-column indexes the correlation can
// enter. 0068 adds the third: `displayMethodSql` correlates on `folio_payments (folio_id)`, indexed
// by 0049 in the same org-led shape — the first cut of this test selected every roll-up but that
// one, and the list still read 121,433 rows on 240 folios. The select below is the handler's.
//
// The pin is the QUERY PLAN, not the index list: an index that exists but is unusable (the
// 0011/0062 shape) is exactly the bug. Every plan line that touches `fl` or an allocations alias
// must be a SEARCH, never a SCAN. The SQL under test is the real one — rendered from the same
// drizzle fragments the handlers compose, so a rewrite of the fragment cannot dodge the test.

const db = getDb(env)

const planOf = async (query: { toSQL(): { sql: string; params: unknown[] } }) => {
  const { sql: text, params } = query.toSQL()
  const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${text}`)
    .bind(...(params as (string | number | null)[]))
    .all<{ detail: string }>()
  return rows.results.map((r) => r.detail)
}

const childScans = (plan: string[]) =>
  plan.filter(
    (line) =>
      /^SCAN (fl|fp|a|a2)\b/.test(line) ||
      /^SCAN folio_(lines|payments|payment_allocations)\b/.test(line),
  )

describe('BUG-042 — folio roll-up correlations enter an index', () => {
  it('the list row: status, hold clock, payment method, refund obligation and amount', async () => {
    const plan = await planOf(
      db
        .select({
          id: folios.id,
          agentName: users.name,
          status: deriveStatusSql,
          bookingExpiresAt: deriveBookingExpiresAtSql,
          paymentMethod: displayMethodSql,
          operatorName: affiliateOperators.name,
          refundStatus: deriveRefundStatusSql,
          refundAmount: deriveRefundAmountSql,
        })
        .from(folios)
        .innerJoin(users, eq(folios.agentId, users.id))
        .leftJoin(affiliateOperators, eq(folios.operatorId, affiliateOperators.id))
        .where(eq(folios.organizationId, 'org')),
    )
    expect(plan.some((l) => l.startsWith('CORRELATED SCALAR SUBQUERY'))).toBe(true)
    expect(childScans(plan)).toEqual([])
    expect(plan.some((l) => /SEARCH fl USING INDEX folio_lines_folio_idx/.test(l))).toBe(true)
    expect(
      plan.some((l) => /SEARCH a2 USING INDEX folio_payment_allocations_line_only_idx/.test(l)),
    ).toBe(true)
    expect(plan.some((l) => /SEARCH fp USING INDEX folio_payments_folio_only_idx/.test(l))).toBe(true)
  })

  it('the facet filters and the pending-work counts', async () => {
    for (const predicate of [
      anyLineStatusSql('paid'),
      anyLineStatusSql('booking'),
      anyLineStatusSql('cancelled'),
      refundPendingFilter(),
    ]) {
      const plan = await planOf(
        db
          .select({ n: sql<number>`count(*)` })
          .from(folios)
          .where(and(eq(folios.organizationId, 'org'), predicate)),
      )
      expect(childScans(plan)).toEqual([])
    }
  })

  it("the list's per-line money mark (readListLines)", async () => {
    const plan = await planOf(
      db
        .select({
          id: folioLines.id,
          allocated: sql<
            number | null
          >`(select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = folio_lines.id)`,
        })
        .from(folioLines)
        .innerJoin(folios, eq(folioLines.folioId, folios.id))
        .where(eq(folioLines.organizationId, 'org')),
    )
    expect(childScans(plan)).toEqual([])
  })
})
