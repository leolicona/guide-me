import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Pending work queues — US-A78 (refunds owed) / US-A79 (apartados past the settle deadline).
// Spec: docs/oversight/pending-work-queues.spec.md (Scenarios S-1…S-11).
//
// Both queues are pure WHERE clauses over columns that already exist — no migration, no stored
// "overdue" state. What is asserted here is therefore narrow and exact: WHO is in each queue, in
// WHAT ORDER, and that neither leaks across organizations.

const ADMIN_EMAIL = 'admin@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const FOLIOS = 'http://api.local/api/folios'

const nowSec = () => Math.floor(Date.now() / 1000)
const hoursFromNow = (h: number) => nowSec() + Math.round(h * 3600)

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
  cancellationSource?: string | null
  bookingExpiresAt?: number | null
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
  cancellationSource = null,
  bookingExpiresAt = null,
}: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at,
        cancelled_at, cancellation_source, refund_status, refund_amount, booking_expires_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      agentId,
      customerName,
      status,
      total,
      total,
      amountPaid ?? total,
      createdAt,
      createdAt,
      cancelledAt,
      cancellationSource,
      refundStatus,
      refundAmount,
      bookingExpiresAt,
    )
    .run()
  return id
}

const clearFoliosDb = async () => {
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM folios')
}

beforeEach(async () => {
  await clearFoliosDb()
  await clearTenancyDb()
})

const listQueue = async (query: string, email = ADMIN_EMAIL) => {
  const res = await SELF.fetch(`${FOLIOS}?${query}`, { headers: auth(email) })
  expect(res.status).toBe(200)
  const body = await res.json<{ folios: Array<Record<string, unknown>> }>()
  return body.folios
}

// --- US-A78 — refunds pending hand-back ------------------------------------

describe('US-A78 — refunds pending hand-back', () => {
  it('S-1 — a cancelled folio owing money appears, with what is owed', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({
      organizationId,
      agentId: userId,
      status: 'cancelled',
      cancelledAt: nowSec() - 3600,
      refundStatus: 'pending',
      refundAmount: 100000,
      cancellationSource: 'admin',
    })

    const rows = await listQueue('refund_status=pending')

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    // The debt itself: the lean list row never carried these before this feature, so the queue
    // could not show what is owed without a second read per folio.
    expect(rows[0].refund_amount).toBe(100000)
    expect(rows[0].refund_status).toBe('pending')
    expect(rows[0].cancelled_at).toBeTypeOf('number')
  })

  it('S-2 — confirming the refund removes it from the queue', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({
      organizationId,
      agentId: userId,
      status: 'cancelled',
      cancelledAt: nowSec() - 3600,
      refundStatus: 'pending',
      refundAmount: 100000,
    })

    expect(await listQueue('refund_status=pending')).toHaveLength(1)

    // The confirm flow itself is US-A23's; here we only assert the queue follows the flag.
    await env.DB.prepare(`UPDATE folios SET refund_status = 'refunded' WHERE id = ?`)
      .bind(id)
      .run()

    expect(await listQueue('refund_status=pending')).toHaveLength(0)
  })

  it('S-3 — a cancellation that owed nothing never enters the queue', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    // Terminal tier: refund = 0, so refund_status stays 'none' (cancellation engine Rule 3).
    await seedFolio({
      organizationId,
      agentId: userId,
      status: 'cancelled',
      cancelledAt: nowSec() - 3600,
      refundStatus: 'none',
      refundAmount: 0,
    })

    expect(await listQueue('refund_status=pending')).toHaveLength(0)
  })

  it('S-4 — oldest debt first', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const base = { organizationId, agentId: userId, status: 'cancelled' as const, refundStatus: 'pending' as const, refundAmount: 50000 }
    // Seeded newest-first on purpose: a default `created_at DESC` ordering would pass by accident.
    const newest = await seedFolio({ ...base, customerName: 'Nueva', cancelledAt: nowSec() - 3600, createdAt: nowSec() - 3600 })
    const oldest = await seedFolio({ ...base, customerName: 'Vieja', cancelledAt: nowSec() - 259200, createdAt: nowSec() - 259200 })
    const middle = await seedFolio({ ...base, customerName: 'Media', cancelledAt: nowSec() - 86400, createdAt: nowSec() - 86400 })

    const rows = await listQueue('refund_status=pending')

    expect(rows.map((r) => r.id)).toEqual([oldest, middle, newest])
  })

  it('S-5 — whoever cancelled it, the debt is listed', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const byAdmin = await seedFolio({
      organizationId, agentId: userId, status: 'cancelled', cancelledAt: nowSec() - 7200,
      refundStatus: 'pending', refundAmount: 100000, cancellationSource: 'admin',
    })
    const bySweep = await seedFolio({
      organizationId, agentId: userId, status: 'cancelled', cancelledAt: nowSec() - 3600,
      refundStatus: 'pending', refundAmount: 30000, cancellationSource: 'system_expiry',
    })

    const rows = await listQueue('refund_status=pending')

    // Filtering by cancellation_source would hide exactly the case this queue exists to catch.
    expect(rows.map((r) => r.id).sort()).toEqual([byAdmin, bySweep].sort())
  })
})

// --- US-A79 — apartados past the settle deadline ----------------------------

describe('US-A79 — apartados past the settle deadline', () => {
  it('S-6 — an expired hold appears', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({
      organizationId, agentId: userId, status: 'booking',
      total: 150000, amountPaid: 45000, bookingExpiresAt: hoursFromNow(-2),
    })

    const rows = await listQueue('overdue=true')

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].pending_balance).toBe(105000)
  })

  it('S-7 — a hold still inside its window does not', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({
      organizationId, agentId: userId, status: 'booking',
      amountPaid: 45000, bookingExpiresAt: hoursFromNow(6),
    })

    expect(await listQueue('overdue=true')).toHaveLength(0)
  })

  it('S-8 — settling removes it (the filter requires status=booking)', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({
      organizationId, agentId: userId, status: 'booking',
      amountPaid: 45000, bookingExpiresAt: hoursFromNow(-2),
    })

    expect(await listQueue('overdue=true')).toHaveLength(1)

    await env.DB.prepare(`UPDATE folios SET status = 'paid', amount_paid = total WHERE id = ?`)
      .bind(id)
      .run()

    expect(await listQueue('overdue=true')).toHaveLength(0)
  })

  it('S-9 — a cancelled apartado is not overdue work', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({
      organizationId, agentId: userId, status: 'cancelled',
      cancelledAt: nowSec() - 600, cancellationSource: 'system_expiry',
      bookingExpiresAt: hoursFromNow(-2), refundStatus: 'none', refundAmount: 0,
    })

    // Gone from the overdue queue — and absent from the refunds queue too, because the terminal
    // tier left nothing to hand back.
    expect(await listQueue('overdue=true')).toHaveLength(0)
    expect(await listQueue('refund_status=pending')).toHaveLength(0)
  })

  it('S-7b — a booking with no expiry set is never overdue', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({
      organizationId, agentId: userId, status: 'booking',
      amountPaid: 45000, bookingExpiresAt: null,
    })

    expect(await listQueue('overdue=true')).toHaveLength(0)
  })

  it('orders the most overdue first', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const base = { organizationId, agentId: userId, status: 'booking' as const, amountPaid: 45000 }
    const recent = await seedFolio({ ...base, customerName: 'Reciente', bookingExpiresAt: hoursFromNow(-1) })
    const ancient = await seedFolio({ ...base, customerName: 'Antiguo', bookingExpiresAt: hoursFromNow(-72) })

    const rows = await listQueue('overdue=true')

    expect(rows.map((r) => r.id)).toEqual([ancient, recent])
  })
})

// --- Composition + unknown values ------------------------------------------

describe('Queue filters compose with the existing ones', () => {
  it('S-10 — one agent’s outstanding debt', async () => {
    const { userId: adminId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const { userId: agentId } = await seedUser({
      email: 'agent@empresa.com', role: 'agent', organizationId,
    })
    const mine = await seedFolio({
      organizationId, agentId, status: 'cancelled', cancelledAt: nowSec() - 3600,
      refundStatus: 'pending', refundAmount: 100000,
    })
    await seedFolio({
      organizationId, agentId: adminId, status: 'cancelled', cancelledAt: nowSec() - 3600,
      refundStatus: 'pending', refundAmount: 80000,
    })

    const rows = await listQueue(`refund_status=pending&agent_id=${agentId}`)

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(mine)
  })

  it('an unknown filter value is ignored, not rejected (matches `status` / `verification`)', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({ organizationId, agentId: userId, status: 'paid' })
    await seedFolio({
      organizationId, agentId: userId, status: 'cancelled', cancelledAt: nowSec(),
      refundStatus: 'pending', refundAmount: 10000,
    })

    // A typo must not 400 on a route where every neighbouring filter falls through silently.
    expect(await listQueue('refund_status=peding')).toHaveLength(2)
    expect(await listQueue('overdue=yes')).toHaveLength(2)
  })
})

// --- Multitenancy (required) ------------------------------------------------

describe('Multitenancy isolation', () => {
  it('S-11 — another org’s pending refund is invisible', async () => {
    const { orgA, orgB } = await seedTwoOrgs()

    const aFolio = await seedFolio({
      organizationId: orgA.organizationId, agentId: orgA.adminUserId, status: 'cancelled',
      cancelledAt: nowSec() - 3600, refundStatus: 'pending', refundAmount: 100000,
    })
    await seedFolio({
      organizationId: orgB.organizationId, agentId: orgB.adminUserId, status: 'cancelled',
      cancelledAt: nowSec() - 7200, refundStatus: 'pending', refundAmount: 90000,
    })

    const rows = await listQueue('refund_status=pending', orgA.adminEmail)

    // Absent, not 403 — a 403 would confirm the other org's folio exists.
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(aFolio)
  })

  it('S-11b — another org’s overdue apartado is invisible', async () => {
    const { orgA, orgB } = await seedTwoOrgs()

    const aFolio = await seedFolio({
      organizationId: orgA.organizationId, agentId: orgA.adminUserId, status: 'booking',
      amountPaid: 45000, bookingExpiresAt: hoursFromNow(-2),
    })
    await seedFolio({
      organizationId: orgB.organizationId, agentId: orgB.adminUserId, status: 'booking',
      amountPaid: 45000, bookingExpiresAt: hoursFromNow(-48),
    })

    const rows = await listQueue('overdue=true', orgA.adminEmail)

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(aFolio)
  })
})
