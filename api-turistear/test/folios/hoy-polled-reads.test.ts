import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { pendingWorkCountQueries } from '../../src/utils/folioPendingWork'
import { dayMoneyQueries, daySlotsQuery } from '../../src/routes/dashboard/handler'
import { clearTenancyDb, materializeSeededFolio, seedTwoOrgs } from '../helpers/tenancy'
import { sessionCookie } from '../helpers/session'

// bug: folio-counts-full-scan (.specify/bugs/folio-counts-full-scan/assessment.md).
//
// Hoy polls GET /api/folios/counts and GET /api/dashboard/day every 60 s (occupancy-dashboard D3).
// Both could narrow by `organization_id` alone, so every poll read the organization's whole
// history: in production (1,011 folios) /counts read 10,346 rows per call and the day's slots and
// ledger reads 2,004 + 1,424 + 1,424 — about 15,200 rows a minute per open screen, to return five
// small counts and twelve departures. One screen open a working day overran the D1 free tier.
//
// BUG-042's lesson stands: the pin is the QUERY PLAN, rendered from the very statements the
// handlers run (pendingWorkCountQueries, daySlotsQuery, dayMoneyQueries), so a rewrite cannot
// dodge it. A read grows with history in one of two shapes, and both are refused:
//
//   SCAN <table>                                   every row of the table
//   SEARCH <t> USING INDEX <i> (organization_id=?) every row of the organization
//
// Plan lines name a table's alias when it has one (`fl`, `f2`, `a`), so the aliases are listed.

const db = getDb(env)

const planOf = async (query: { toSQL(): { sql: string; params: unknown[] } }) => {
  const { sql: text, params } = query.toSQL()
  const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${text}`)
    .bind(...(params as (string | number | null)[]))
    .all<{ detail: string }>()
  return rows.results.map((r) => r.detail)
}

// devolada-transfer-verification D14 — `verification_auto` reads folio_payments as `p`, and the
// Devolada tables as `l`, `dp` and `dc`. `devolada_connections` holds one row per organization
// (devolada_connections_org_uq): entering it by organization reads that row, never a history.
const ONE_ROW_PER_ORG = /USING INDEX devolada_connections_org_uq \(organization_id=\?\)$/

const historyReads = (plan: string[]) =>
  plan.filter(
    (line) =>
      /^SCAN (folios|f2|folio_lines|fl|folio_payment_allocations|a|folio_requests|slots|folio_payments|p|devolada_links|l|devolada_payments|dp|devolada_connections|dc)\b/.test(
        line,
      ) ||
      (/^SEARCH \S+ USING (COVERING )?INDEX \S+ \(organization_id=\?\)$/.test(line) && !ONE_ROW_PER_ORG.test(line)),
  )

describe('bug: folio-counts-full-scan — the polled reads enter what is pending, not the history', () => {
  it('each pending-work count is driven from its candidate set', async () => {
    const queries = pendingWorkCountQueries(db, 'org', new Date())
    for (const [name, query] of Object.entries(queries)) {
      // The tenant term is still there — only out of index selection. Each predicate's own
      // org-scoped subquery would keep the counts right without it (see the isolation test), so
      // nothing else would notice it gone.
      expect(query.toSQL().sql, name).toMatch(/^select .* where \(\+"folios"\."organization_id" = \? and /)
      const plan = await planOf(query)
      expect(historyReads(plan), name).toEqual([])
      // Driven FROM the candidates: each one's folio is fetched by primary key. Were the tenant
      // term indexable, the planner would enter folios by organization instead and test every
      // folio against the list — the bug, in its exact shape.
      expect(
        plan.some((l) => /^SEARCH folios USING (COVERING )?INDEX sqlite_autoindex_folios_1 \(id=\?\)$/.test(l)),
        name,
      ).toBe(true)
    }
  })

  it("Hoy's day reads enter the day", async () => {
    const slotsPlan = await planOf(daySlotsQuery(db, 'org', '2026-06-14'))
    expect(historyReads(slotsPlan)).toEqual([])
    expect(
      slotsPlan.some((l) => /^SEARCH slots USING INDEX slots_org_date_idx \(organization_id=\? AND date=\?\)$/.test(l)),
    ).toBe(true)

    const money = dayMoneyQueries(
      db,
      'org',
      new Date('2026-06-14T06:00:00Z'),
      new Date('2026-06-15T05:59:59Z'),
    )
    for (const [name, query] of Object.entries(money)) {
      const plan = await planOf(query)
      expect(historyReads(plan), name).toEqual([])
      expect(
        plan.some((l) =>
          /^SEARCH folio_payments USING (COVERING )?INDEX folio_payments_org_created_idx \(organization_id=\? AND created_at>\? AND created_at<\?\)$/.test(
            l,
          ),
        ),
        name,
      ).toBe(true)
    }
  })
})

// --- Isolation: every count, both organizations holding every kind of work --------------------
//
// The counts are now scoped twice: by the tenant term (`+folios.organization_id = ?`, which only
// filters) and inside every predicate's candidate subquery. Either alone keeps the answer right,
// so the test seeds pending work of every kind in BOTH orgs, in different amounts: a count that
// loses its scope entirely reads the sum, and no kind can hide behind another being empty. That
// includes a sale Devolada is resolving, for `verification_auto` (devolada-transfer-verification
// D14), which is pending verification too.

const nowSec = () => Math.floor(Date.now() / 1000)

const seedFolio = async (o: {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  amountPaid?: number
  refundStatus?: 'none' | 'pending'
  bookingExpiresAt?: number | null
  paymentVerification?: 'not_required' | 'pending' | 'verified'
  ticketsSentAt?: number | null
}): Promise<string> => {
  const id = crypto.randomUUID()
  const total = 100000
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, status, subtotal, discount_total, total,
        amount_paid, created_at, updated_at, cancelled_at, refund_status, refund_amount,
        booking_expires_at, payment_verification, tickets_sent_at, tickets_viewed_at)
     VALUES (?, ?, ?, 'Cliente', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, o.organizationId, o.agentId, o.status ?? 'paid', total, total, o.amountPaid ?? total,
      ts, ts, o.status === 'cancelled' ? ts : null, o.refundStatus ?? 'none',
      o.refundStatus === 'pending' ? total : 0, o.bookingExpiresAt ?? null,
      o.paymentVerification ?? 'not_required', o.ticketsSentAt ?? null, o.ticketsSentAt ?? null,
    )
    .run()
  await materializeSeededFolio(id)
  return id
}

/** One folio of each kind of pending work, plus one inert folio carrying a pending request. */
const seedEveryKind = async (organizationId: string, agentId: string) => {
  const delivered = nowSec() - 60
  await seedFolio({ organizationId, agentId, paymentVerification: 'pending' })
  await seedFolio({ organizationId, agentId, status: 'cancelled', refundStatus: 'pending' })
  await seedFolio({
    organizationId, agentId, status: 'booking', amountPaid: 30000, bookingExpiresAt: nowSec() - 3600,
  })
  await seedFolio({ organizationId, agentId, paymentVerification: 'verified' })
  const requested = await seedFolio({
    organizationId, agentId, paymentVerification: 'verified', ticketsSentAt: delivered,
  })
  await env.DB.prepare(
    `INSERT INTO folio_requests (id, organization_id, folio_id, status, reason, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'motivo', ?, ?)`,
  )
    .bind(crypto.randomUUID(), organizationId, requested, nowSec(), nowSec())
    .run()
  // A transfer an open enlace collects, waiting for its first payment: Devolada resolves it.
  const collected = await seedFolio({ organizationId, agentId, paymentVerification: 'pending' })
  const credentialId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO devolada_credentials (id, organization_id, mode, ciphertext, iv, key_hint, created_by, created_at)
     VALUES (?, ?, 'test', 'x', 'y', 'abcd', ?, ?)`,
  )
    .bind(credentialId, organizationId, agentId, nowSec())
    .run()
  await env.DB.prepare(
    `INSERT INTO devolada_links (id, organization_id, folio_id, folio_payment_id, kind, credential_id, mode, amount, devolada_link_id, expires_at, state, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'sale', ?, 'test', 100000, ?, ?, 'open', ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(), organizationId, collected, `pmt_${collected}`, credentialId,
      `lnk_${crypto.randomUUID()}`, nowSec() + 3600, agentId, nowSec(), nowSec(),
    )
    .run()
}

const counts = async (email: string) => {
  const res = await SELF.fetch('http://api.local/api/folios/counts', {
    headers: { Cookie: sessionCookie(email) },
  })
  expect(res.status).toBe(200)
  return res.json<Record<string, number>>()
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM devolada_links')
  await env.DB.exec('DELETE FROM devolada_credentials')
  await env.DB.exec('DELETE FROM folio_requests')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folio_events')
  await env.DB.exec('DELETE FROM folios')
  await clearTenancyDb()
})

describe('bug: folio-counts-full-scan — multitenancy', () => {
  it("org A's counts never include org B's pending work, of any kind", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedEveryKind(orgA.organizationId, orgA.adminUserId)
    await seedEveryKind(orgB.organizationId, orgB.adminUserId)
    await seedEveryKind(orgB.organizationId, orgB.adminUserId)

    // The Devolada sale is pending verification too: «Por verificar» shows the difference.
    const one = {
      verification: 2, verification_auto: 1, refunds: 1, overdue: 1, undelivered: 1, folio_requests: 1,
    }
    const two = {
      verification: 4, verification_auto: 2, refunds: 2, overdue: 2, undelivered: 2, folio_requests: 2,
    }
    expect(await counts(orgA.adminEmail)).toEqual(one)
    expect(await counts(orgB.adminEmail)).toEqual(two)
  })
})
