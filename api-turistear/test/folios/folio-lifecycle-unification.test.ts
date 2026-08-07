import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A84 — the folio is one object, not five screens.
// Spec: docs/oversight/folio-lifecycle-unification.spec.md (Scenarios S-1…S-6, S-11, S-17…S-19;
// the rest are frontend and live in the app's own suites).
//
// What is worth asserting here is narrow: the read is BOUNDED without becoming INCOMPLETE. Every
// test below exists to catch one specific way that could go wrong — most of all S-4, which fails
// the moment somebody replaces the union with a plain window because it reads correct.

const ADMIN_EMAIL = 'admin@empresa.com'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const FOLIOS = 'http://api.local/api/folios'

const nowSec = () => Math.floor(Date.now() / 1000)
const daysAgo = (d: number) => nowSec() - d * 86400

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  customerName?: string
  total?: number
  amountPaid?: number
  createdAt?: number
  cancelledAt?: number | null
  refundStatus?: 'none' | 'pending' | 'refunded'
  refundAmount?: number
  bookingExpiresAt?: number | null
  paymentVerification?: 'not_required' | 'pending' | 'verified'
  ticketsSentAt?: number | null
  ticketsViewedAt?: number | null
}

const seedFolio = async ({
  organizationId,
  agentId,
  status = 'paid',
  customerName = 'John Diver',
  total = 150000,
  amountPaid,
  createdAt = nowSec(),
  cancelledAt = null,
  refundStatus = 'none',
  refundAmount = 0,
  bookingExpiresAt = null,
  paymentVerification = 'not_required',
  ticketsSentAt = null,
  ticketsViewedAt = null,
}: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at,
        cancelled_at, refund_status, refund_amount, booking_expires_at,
        payment_verification, tickets_sent_at, tickets_viewed_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, organizationId, agentId, customerName, status, total, total,
      amountPaid ?? total, createdAt, createdAt, cancelledAt, refundStatus,
      refundAmount, bookingExpiresAt, paymentVerification, ticketsSentAt, ticketsViewedAt,
    )
    .run()
  return id
}

const seedRequest = async (
  organizationId: string,
  folioId: string,
  status: 'pending' | 'approved' | 'rejected',
  createdAt = nowSec(),
): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folio_requests
       (id, organization_id, folio_id, status, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, organizationId, folioId, status, `motivo ${status}`, createdAt, createdAt)
    .run()
  return id
}

/** A folio that is settled, delivered and owes nothing — the ONLY shape the window can drop. */
const seedInertFolio = (organizationId: string, agentId: string, createdAt: number) =>
  seedFolio({
    organizationId, agentId, createdAt,
    paymentVerification: 'verified', ticketsSentAt: createdAt, ticketsViewedAt: createdAt,
  })

beforeEach(async () => {
  await env.DB.exec('DELETE FROM folio_requests')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folio_events')
  await env.DB.exec('DELETE FROM folios')
  await clearTenancyDb()
})

const list = async (query = '', email = ADMIN_EMAIL) => {
  const res = await SELF.fetch(`${FOLIOS}${query ? `?${query}` : ''}`, { headers: auth(email) })
  expect(res.status).toBe(200)
  return res.json<{ folios: Array<Record<string, unknown>>; window_days: number | null }>()
}

const counts = async (email = ADMIN_EMAIL) => {
  const res = await SELF.fetch(`${FOLIOS}/counts`, { headers: auth(email) })
  expect(res.status).toBe(200)
  return res.json<Record<string, number>>()
}

// --- The union: bounded without becoming incomplete (rules 1-3) ---------------

describe('US-A84 — the load window is a union, not a page', () => {
  it('S-1 — a pending refund older than the window is still returned', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const old = await seedFolio({
      organizationId, agentId: userId, status: 'cancelled',
      createdAt: daysAgo(240), cancelledAt: daysAgo(240),
      refundStatus: 'pending', refundAmount: 100000,
    })

    const body = await list()

    expect(body.folios.map((f) => f.id)).toContain(old)
    expect(body.window_days).toBe(30)
  })

  it('S-1b — every other kind of pending work survives the window too', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const unverified = await seedFolio({
      organizationId, agentId: userId, createdAt: daysAgo(120), paymentVerification: 'pending',
    })
    const overdue = await seedFolio({
      organizationId, agentId: userId, status: 'booking', createdAt: daysAgo(120),
      amountPaid: 50000, bookingExpiresAt: daysAgo(90),
    })
    const undelivered = await seedFolio({
      organizationId, agentId: userId, createdAt: daysAgo(120), paymentVerification: 'verified',
    })
    const requested = await seedInertFolio(organizationId, userId, daysAgo(120))
    await seedRequest(organizationId, requested, 'pending')

    const ids = (await list()).folios.map((f) => f.id)

    // Each of the five predicates, independently. A union that forgets one silently re-creates the
    // lying-facet bug for exactly that queue.
    expect(ids).toContain(unverified)
    expect(ids).toContain(overdue)
    expect(ids).toContain(undelivered)
    expect(ids).toContain(requested)
  })

  it('S-2 — a settled, delivered folio older than the window is dropped', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const inert = await seedInertFolio(organizationId, userId, daysAgo(200))
    const recent = await seedInertFolio(organizationId, userId, daysAgo(3))

    const ids = (await list()).folios.map((f) => f.id)

    expect(ids).toContain(recent)
    expect(ids).not.toContain(inert)
  })

  it('S-2b — an explicit date filter replaces the window and reaches the past', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const created = daysAgo(200)
    const inert = await seedInertFolio(organizationId, userId, created)
    const day = new Date(created * 1000).toISOString().slice(0, 10)

    const body = await list(`date=${day}`)

    // Without this, `[Rango ▾]` would reach into the past and silently return nothing.
    expect(body.folios.map((f) => f.id)).toContain(inert)
    expect(body.window_days).toBeNull()
  })
})

// --- The counts describe the organization, never the window (rules 4-5) --------

describe('US-A84 — the counts are counts', () => {
  it('S-3 — a pending refund outside the window is still counted', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({
      organizationId, agentId: userId, status: 'cancelled',
      createdAt: daysAgo(240), cancelledAt: daysAgo(240),
      refundStatus: 'pending', refundAmount: 100000,
    })

    expect((await counts()).refunds).toBe(1)
  })

  it('S-4 — the banner count and its destination agree', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const base = {
      organizationId, agentId: userId, status: 'cancelled' as const,
      refundStatus: 'pending' as const, refundAmount: 50000,
    }
    await seedFolio({ ...base, createdAt: daysAgo(240), cancelledAt: daysAgo(240) })
    await seedFolio({ ...base, createdAt: daysAgo(2), cancelledAt: daysAgo(2) })
    // Noise the facet must exclude, inside and outside the window.
    await seedInertFolio(organizationId, userId, daysAgo(1))
    await seedInertFolio(organizationId, userId, daysAgo(300))

    const { refunds } = await counts()
    const listed = (await list()).folios.filter((f) => f.refund_status === 'pending')

    // THE assertion of this feature: what the pill promises is what the filtered list delivers.
    // Replacing the union with a plain window makes `refunds` 2 and `listed` 1 — and every other
    // test in this file still passes.
    expect(refunds).toBe(2)
    expect(listed).toHaveLength(refunds)
  })

  it('S-4b — a folio with history plus a live request counts once', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const folio = await seedInertFolio(organizationId, userId, daysAgo(1))
    // `uq_folio_requests_open` (migration 0028) is a PARTIAL unique index — one *pending*
    // request per folio, but resolved ones accumulate. So the count can only over-report by
    // counting request rows instead of folios, and this is the shape where it would: three rows,
    // one folio, one job.
    await seedRequest(organizationId, folio, 'rejected', daysAgo(20))
    await seedRequest(organizationId, folio, 'rejected', daysAgo(10))
    await seedRequest(organizationId, folio, 'pending', daysAgo(1))

    const { folio_requests } = await counts()
    const listed = (await list()).folios.filter((f) => f.cancellation_request === 'pending')

    // The pill reads "1 Solicitud" beside a list that shows one row.
    expect(folio_requests).toBe(1)
    expect(listed).toHaveLength(1)
  })

  it('each count uses the SAME predicate its former tab used', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    // A rejected payment cancels the folio and leaves its stale 'pending' flag behind — US-A67's
    // queue always excluded it, and the count must too.
    await seedFolio({
      organizationId, agentId: userId, status: 'cancelled',
      paymentVerification: 'pending', createdAt: daysAgo(1),
    })
    await seedFolio({ organizationId, agentId: userId, paymentVerification: 'pending' })

    expect((await counts()).verification).toBe(1)
  })

  it('an unverified transfer is not counted as undelivered', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    // `deliveryState()` puts a folio on the delivery axis only once the money cleared, so an
    // unverified transfer is verification work, not delivery work. Counting it twice would make
    // the banner claim more pending jobs than exist.
    await seedFolio({ organizationId, agentId: userId, paymentVerification: 'pending' })

    const c = await counts()
    expect(c.verification).toBe(1)
    expect(c.undelivered).toBe(0)
  })
})

// --- The absorbed cancellation requests (rules 6-7) ----------------------------

describe('US-A84 — Solicitudes, absorbed', () => {
  it('S-5 — a folio with a live request is marked pending', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const folio = await seedInertFolio(organizationId, userId, daysAgo(1))
    await seedRequest(organizationId, folio, 'pending')

    const row = (await list()).folios.find((f) => f.id === folio)

    expect(row?.cancellation_request).toBe('pending')
  })

  it('S-6 — a folio whose only request was rejected is resolved, not pending', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const folio = await seedInertFolio(organizationId, userId, daysAgo(1))
    await seedRequest(organizationId, folio, 'rejected')

    const row = (await list()).folios.find((f) => f.id === folio)

    // This is the `Con solicitud` facet's whole basis, and the reason it is not just a boolean:
    // a rejected request left the folio untouched, so nothing else on the row records it.
    expect(row?.cancellation_request).toBe('resolved')
  })

  it("S-6b — a live request wins over a resolved one on the same folio", async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const folio = await seedInertFolio(organizationId, userId, daysAgo(1))
    // Rejected FIRST, so a naive "last row wins" reduction would answer 'resolved'.
    await seedRequest(organizationId, folio, 'rejected', daysAgo(5))
    await seedRequest(organizationId, folio, 'pending', daysAgo(1))

    const row = (await list()).folios.find((f) => f.id === folio)

    expect(row?.cancellation_request).toBe('pending')
  })

  it('a folio with no request is null, not resolved', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const folio = await seedInertFolio(organizationId, userId, daysAgo(1))

    expect((await list()).folios.find((f) => f.id === folio)?.cancellation_request).toBeNull()
  })

  it('S-7 — the folio detail carries the full request history, newest first', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const folio = await seedInertFolio(organizationId, userId, daysAgo(1))
    await seedRequest(organizationId, folio, 'rejected', daysAgo(9))
    await seedRequest(organizationId, folio, 'approved', daysAgo(2))

    const res = await SELF.fetch(`${FOLIOS}/${folio}`, { headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(200)
    const body = await res.json<{
      folio: { folio_requests: Array<Record<string, unknown>> }
    }>()

    // The detail is where the absorbed tab lands: without this, rejecting a request erases it.
    expect(body.folio.folio_requests.map((r) => r.status)).toEqual(['approved', 'rejected'])
    expect(body.folio.folio_requests[1].reason).toBe('motivo rejected')
  })
})

// --- One order, and the per-row overdue flag (rules 9, D10) --------------------

describe('US-A84 — one order', () => {
  it('S-11 — the sort no longer depends on the filter', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const base = {
      organizationId, agentId: userId, status: 'cancelled' as const,
      refundStatus: 'pending' as const, refundAmount: 50000,
    }
    const old = await seedFolio({ ...base, createdAt: daysAgo(9), cancelledAt: daysAgo(9) })
    const recent = await seedFolio({ ...base, createdAt: daysAgo(1), cancelledAt: daysAgo(1) })

    const unfiltered = (await list()).folios.map((f) => f.id)
    const filtered = (await list('refund_status=pending')).folios.map((f) => f.id)

    expect(unfiltered).toEqual([recent, old])
    expect(filtered).toEqual([recent, old])
  })

  it('the row states whether the hold is overdue', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const late = await seedFolio({
      organizationId, agentId: userId, status: 'booking',
      amountPaid: 50000, bookingExpiresAt: daysAgo(2),
    })
    const onTime = await seedFolio({
      organizationId, agentId: userId, status: 'booking',
      amountPaid: 50000, bookingExpiresAt: nowSec() + 86400,
    })

    const rows = (await list()).folios

    expect(rows.find((f) => f.id === late)?.overdue).toBe(true)
    expect(rows.find((f) => f.id === onTime)?.overdue).toBe(false)
  })
})

// --- Multitenancy -------------------------------------------------------------

describe('US-A84 — multitenancy', () => {
  it('S-17 — another org\'s pending work is invisible in the counts', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedFolio({
      organizationId: orgB.organizationId, agentId: orgB.adminUserId, status: 'cancelled',
      cancelledAt: daysAgo(1), refundStatus: 'pending', refundAmount: 90000,
    })

    expect((await counts(orgA.adminEmail)).refunds).toBe(0)
    expect((await counts(orgB.adminEmail)).refunds).toBe(1)
  })

  // S-18 — SAME-ORG ATTRIBUTION, which is the only form of this assertion with teeth.
  //
  // What follows is the lesson US-A82's S-8 taught and this build re-learned by measurement. The
  // cross-org version of this test — org B holds a request, assert org A's row is unmarked — was
  // written first and then MUTATION-TESTED: removing the org scope from
  // `readListCancellationRequests` left it green, and so did removing the join and the filters
  // **entirely**. The reason is structural: the response reads `requestByFolio.get(r.id)` for ids
  // it already owns, so a foreign row simply sits unused in the map. That decoration cannot leak
  // across orgs no matter how it is scoped, and a test claiming otherwise would be decoration.
  //
  // Isolation on this route is enforced by `eq(folios.organizationId, org)` in the main query's
  // `filters`, carried into every decoration through the join. The second scope inside the
  // decoration is defence in depth, matching `readListLines`/`readListPortalLinks` — not the thing
  // that holds the line.
  //
  // What CAN break, and what this asserts: the mark landing on the wrong folio. Two folios in ONE
  // org, one request. Mis-key the grouping (by request id, or a join on the wrong column) and the
  // mark moves to a folio nobody asked to cancel — an admin pressing `Revisar solicitud` on the
  // wrong sale.
  it('S-18 — the mark lands on the folio the request is about, and no other', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const withRequest = await seedInertFolio(organizationId, userId, daysAgo(2))
    const without = await seedInertFolio(organizationId, userId, daysAgo(1))
    await seedRequest(organizationId, withRequest, 'pending')

    const rows = (await list()).folios

    expect(rows.find((f) => f.id === withRequest)?.cancellation_request).toBe('pending')
    expect(rows.find((f) => f.id === without)?.cancellation_request).toBeNull()
  })

  it("S-18b — org A sees only org A's folios", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const aFolio = await seedInertFolio(orgA.organizationId, orgA.adminUserId, daysAgo(1))
    const bFolio = await seedInertFolio(orgB.organizationId, orgB.adminUserId, daysAgo(1))
    await seedRequest(orgB.organizationId, bFolio, 'pending')

    const aRows = (await list('', orgA.adminEmail)).folios
    const bRows = (await list('', orgB.adminEmail)).folios

    // This one guards the MAIN query's org scope — the predicate that actually enforces isolation.
    // It says nothing about how the decorations are scoped (see S-18's note).
    expect(aRows.map((f) => f.id)).toEqual([aFolio])
    expect(bRows.map((f) => f.id)).toEqual([bFolio])
    expect(bRows[0].cancellation_request).toBe('pending')
  })

  it("S-19 — another org's folio detail is 404", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const bFolio = await seedFolio({
      organizationId: orgB.organizationId, agentId: orgB.adminUserId,
    })

    const res = await SELF.fetch(`${FOLIOS}/${bFolio}`, { headers: auth(orgA.adminEmail) })

    // 404, never 403 — which would confirm it exists.
    expect(res.status).toBe(404)
  })

  it('the counts endpoint is admin-only', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedUser({ email: 'agente@empresa.com', role: 'agent', organizationId })

    const res = await SELF.fetch(`${FOLIOS}/counts`, { headers: auth('agente@empresa.com') })

    expect(res.status).toBe(403)
  })
})
