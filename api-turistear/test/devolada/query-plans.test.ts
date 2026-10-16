// devolada-transfer-verification US1 — BUG-042 for the Devolada reads (task T074; constitution
// § Additional constraints): every correlated subquery keyed by a child column enters an index, so
// `EXPLAIN QUERY PLAN` shows no `SCAN` inside a correlated subquery. The SQL under test is the real
// one, rendered from the same drizzle builders and fragments the handlers and the sweep run.
//
// PR 1 covers the reads it ships: the sale's links and payments, `verification_auto` (filter, count
// and list column), the connection view's previous keys and the sweep's credential cleanup. PR 2
// adds the attention filter and count and the apartado expiry guard; PR 3 the sweep's selection of
// closed links whose payment is in flight.
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '../../src/db/client'
import { folios } from '../../src/db/schema'
import {
  devoladaAttentionFilter,
  pendingWorkCountQueries,
  verificationAutoFilter,
  verificationPendingFilter,
} from '../../src/utils/folioPendingWork'
import { linkPaymentRowsQuery, paymentLinkRowsQuery } from '../../src/utils/devoladaLinkView'
import { previousKeysQuery } from '../../src/routes/devolada/connection'
import { erasableCredentialsQuery } from '../../src/routes/devolada/sweep'
import { dueApartadosQuery } from '../../src/routes/pos/sweep'

const db = getDb(env)
const NOW = new Date('2026-06-14T12:00:00Z')

interface PlanRow {
  id: number
  parent: number
  detail: string
}

const planOf = async (query: { toSQL(): { sql: string; params: unknown[] } }): Promise<PlanRow[]> => {
  const { sql: text, params } = query.toSQL()
  const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${text}`)
    .bind(...(params as (string | number | null)[]))
    .all<PlanRow>()
  return rows.results
}

/** Plan lines that SCAN anywhere below a correlated subquery, however deep. */
const scansInsideCorrelated = (plan: PlanRow[]): string[] => {
  const byId = new Map(plan.map((row) => [row.id, row]))
  const insideCorrelated = (row: PlanRow): boolean => {
    for (let up = byId.get(row.parent); up; up = byId.get(up.parent)) {
      if (up.detail.startsWith('CORRELATED')) return true
    }
    return false
  }
  return plan.filter((row) => row.detail.startsWith('SCAN') && insideCorrelated(row)).map((row) => row.detail)
}

/** Plan lines that SCAN a Devolada table, at any level. */
const devoladaScans = (plan: PlanRow[]): string[] =>
  plan
    .map((row) => row.detail)
    .filter((line) => /^SCAN (devolada_(links|payments|connections)|l|dl|dp|dc|hl|ll|hd|hp)\b/.test(line))

const details = (plan: PlanRow[]) => plan.map((row) => row.detail)

describe('BUG-042 — the Devolada reads enter an index', () => {
  it("a sale's links and their payments, by id and through the list's filters", async () => {
    for (const scope of [
      { folioIds: ['folio-1', 'folio-2'] },
      { filters: [eq(folios.organizationId, 'org'), verificationPendingFilter('org')] },
    ]) {
      for (const query of [paymentLinkRowsQuery(db, 'org', scope), linkPaymentRowsQuery(db, 'org', scope)]) {
        const plan = await planOf(query)
        expect(devoladaScans(plan), details(plan).join('\n')).toEqual([])
        expect(scansInsideCorrelated(plan), details(plan).join('\n')).toEqual([])
      }
    }
  })

  it('verification_auto: the count, and the 0/1 column of the lists and the detail', async () => {
    // The statement GET /folios/counts runs (test/folios/hoy-polled-reads.test.ts pins its entry).
    const count = await planOf(pendingWorkCountQueries(db, 'org', NOW).verification_auto)
    const column = await planOf(
      db
        .select({
          id: folios.id,
          verificationAuto: sql<number>`case when ${verificationAutoFilter('org', NOW)} then 1 else 0 end`,
        })
        .from(folios)
        .where(eq(folios.organizationId, 'org')),
    )
    for (const plan of [count, column]) {
      expect(plan.some((row) => row.detail.startsWith('CORRELATED'))).toBe(true)
      expect(scansInsideCorrelated(plan), details(plan).join('\n')).toEqual([])
      expect(devoladaScans(plan), details(plan).join('\n')).toEqual([])
      // The current payment of a link is read through `devolada_payments (link_id)`.
      expect(details(plan).some((l) => /SEARCH dp USING INDEX devolada_payments_link_idx/.test(l))).toBe(true)
    }
  })

  it("the connection view's previous keys", async () => {
    const plan = await planOf(previousKeysQuery(db, 'org'))
    expect(scansInsideCorrelated(plan), details(plan).join('\n')).toEqual([])
    expect(devoladaScans(plan), details(plan).join('\n')).toEqual([])
    expect(details(plan).some((l) => /SEARCH dl USING .*INDEX devolada_links_credential_idx/.test(l))).toBe(true)
  })

  it("the sweep's cleanup of retired credentials", async () => {
    const plan = await planOf(erasableCredentialsQuery(db))
    expect(plan.some((row) => row.detail.startsWith('CORRELATED'))).toBe(true)
    expect(scansInsideCorrelated(plan), details(plan).join('\n')).toEqual([])
    expect(details(plan).some((l) => /SEARCH dl USING .*INDEX devolada_links_credential_idx/.test(l))).toBe(true)
    expect(details(plan).some((l) => /SEARCH dp USING INDEX devolada_payments_link_idx/.test(l))).toBe(true)
  })

  it('devolada_attention: the count, and the 0/1 column, enter by their candidate payments', async () => {
    const count = await planOf(pendingWorkCountQueries(db, 'org', NOW).devolada_attention)
    const column = await planOf(
      db
        .select({ id: folios.id, attention: sql<number>`case when ${devoladaAttentionFilter('org')} then 1 else 0 end` })
        .from(folios)
        .where(eq(folios.organizationId, 'org')),
    )
    for (const plan of [count, column]) {
      expect(scansInsideCorrelated(plan), details(plan).join('\n')).toEqual([])
      expect(devoladaScans(plan), details(plan).join('\n')).toEqual([])
      // The candidates: the organization's payments in an attention status, then each one's link.
      expect(details(plan).some((l) => /SEARCH dp USING INDEX devolada_payments_status_idx \(organization_id=\? AND status=\?\)/.test(l)), details(plan).join('\n')).toBe(true)
      expect(details(plan).some((l) => /SEARCH l USING INDEX sqlite_autoindex_devolada_links_1 \(id=\?\)/.test(l)), details(plan).join('\n')).toBe(true)
    }
  })

  it("the apartado expiry sweep's holds read each apartado's links through (organization_id, folio_id)", async () => {
    const plan = await planOf(dueApartadosQuery(db, NOW))
    expect(scansInsideCorrelated(plan), details(plan).join('\n')).toEqual([])
    expect(devoladaScans(plan), details(plan).join('\n')).toEqual([])
    for (const alias of ['hl', 'll']) {
      expect(
        details(plan).some((l) => new RegExp(`SEARCH ${alias} USING INDEX devolada_links_folio_idx \\(organization_id=\\? AND folio_id=\\?\\)`).test(l)),
        details(plan).join('\n'),
      ).toBe(true)
    }
    // A settlement payment awaiting the admin is read through `devolada_payments (link_id)`.
    expect(details(plan).some((l) => /SEARCH hd USING INDEX devolada_payments_link_idx/.test(l)), details(plan).join('\n')).toBe(true)
  })
})
