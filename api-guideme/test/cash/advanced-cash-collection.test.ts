import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Advanced Cash Collection — Admin-Initiated Collections & Adjustments.
// US-A27, US-A28 (admin) · US-AG27, US-AG28 (agent).
// Spec: docs/cash-drops/advanced-cash-collection.spec.md
//
// An admin can DIRECT-COLLECT cash from an agent (immediate confirmed drop, source='admin')
// and can CONFIRM-WITH-ADJUSTMENT. Both are unilateral money-moves that owe the agent a
// non-blocking SIGNATURE: the agent may SIGN or DISPUTE; an unsigned obligation AUTO-SIGNS once
// the org's window elapses (configurable, default 24h). Acknowledgment is financially inert —
// it never changes the balance. Disputes do not reverse money; the admin RESOLVES them (audit
// close), correcting via a compensating payout/collection if needed.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'
const AGENT2_EMAIL = 'agent2@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const CASH = 'http://api.local/api/cash'
const nowSec = () => Math.floor(Date.now() / 1000)
const HOUR = 3600

// --- Seeders (raw D1) ------------------------------------------------------

const seedFolio = async (opts: {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  amountPaid: number
  paymentMethod?: 'cash' | 'card'
  commissionAmount?: number
  createdAt?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = opts.createdAt ?? nowSec()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, status, payment_method,
        subtotal, discount_total, total, amount_paid, commission_amount,
        cancellation_clawback, cancelled_at, created_at, updated_at)
     VALUES (?, ?, ?, 'John Diver', ?, ?, ?, 0, ?, ?, ?, 0, NULL, ?, ?)`,
  )
    .bind(
      id,
      opts.organizationId,
      opts.agentId,
      opts.status ?? 'paid',
      opts.paymentMethod ?? 'cash',
      opts.amountPaid,
      opts.amountPaid,
      opts.amountPaid,
      opts.commissionAmount ?? 0,
      ts,
      ts,
    )
    .run()
  return id
}

const seedDrop = async (opts: {
  organizationId: string
  agentId: string
  amount: number
  balanceBefore?: number
  balanceAfter?: number | null
  status?: 'pending' | 'confirmed' | 'rejected'
  source?: 'agent' | 'admin'
  acknowledgment?: string
  acknowledgedAt?: number | null
  ackNote?: string | null
  reviewedBy?: string | null
  reviewedAt?: number | null
  createdAt?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = opts.createdAt ?? nowSec()
  await env.DB.prepare(
    `INSERT INTO cash_drops
       (id, organization_id, agent_id, amount, balance_before, balance_after, status, source,
        acknowledgment, acknowledged_at, ack_note, note, reviewed_by, reviewed_at, review_note,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      id,
      opts.organizationId,
      opts.agentId,
      opts.amount,
      opts.balanceBefore ?? 0,
      opts.balanceAfter ?? null,
      opts.status ?? 'pending',
      opts.source ?? 'agent',
      opts.acknowledgment ?? 'not_required',
      opts.acknowledgedAt ?? null,
      opts.ackNote ?? null,
      opts.reviewedBy ?? null,
      opts.reviewedAt ?? null,
      ts,
      ts,
    )
    .run()
  return id
}

const setAckWindow = (organizationId: string, hours: number) =>
  env.DB.prepare(`UPDATE organizations SET ack_window_hours = ? WHERE id = ?`)
    .bind(hours, organizationId)
    .run()

const getDropRow = (id: string) =>
  env.DB.prepare(
    `SELECT source, status, acknowledgment, acknowledged_at, ack_note, ack_resolved_by,
            amount, balance_before, balance_after, review_note
       FROM cash_drops WHERE id = ?`,
  )
    .bind(id)
    .first<{
      source: string
      status: string
      acknowledgment: string
      acknowledged_at: number | null
      ack_note: string | null
      ack_resolved_by: string | null
      amount: number
      balance_before: number
      balance_after: number | null
      review_note: string | null
    }>()

const countDrops = async () =>
  Number((await env.DB.prepare(`SELECT count(*) AS c FROM cash_drops`).first<{ c: number }>())?.c ?? 0)

// --- API helpers -----------------------------------------------------------

const getMyBalance = async (email: string) => {
  const res = await SELF.fetch(`${CASH}/me`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const createDrop = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/me/drops`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const reviewDrop = async (email: string, id: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/drops/${id}/review`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const registerCollection = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/collections`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const acknowledgeDrop = async (email: string, id: string) => {
  const res = await SELF.fetch(`${CASH}/me/drops/${id}/acknowledge`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({}),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const disputeDrop = async (email: string, id: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/me/drops/${id}/dispute`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const resolveDispute = async (email: string, id: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/drops/${id}/resolve-dispute`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const listDrops = async (email: string, query = '') => {
  const res = await SELF.fetch(`${CASH}/drops${query ? `?${query}` : ''}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const registerPayout = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/payouts`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const errCode = (json: any): string => json.error?.code ?? json.code

const seedOrgWithStaff = async () => {
  const { organizationId, userId: adminId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const { userId: agentId } = await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  return { organizationId, adminId, agentId }
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM payouts')
  await env.DB.exec('DELETE FROM cash_drops')
  await env.DB.exec('DELETE FROM agent_expenses')
  await env.DB.exec('DELETE FROM cancellation_requests')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM cancellation_requests')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folios')
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('Advanced Cash Collection — collections, adjustments & acknowledgments', () => {
  // -------------------------------------------------------------------------
  // US-A27 — admin direct collection
  // -------------------------------------------------------------------------
  it('S1 — direct collection reduces the balance immediately, owes a signature, becomes the anchor', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 1200000 })

    const res = await registerCollection(ADMIN_EMAIL, { agent_id: agentId, amount: 500000, note: 'Cobro en ruta' })
    expect(res.status).toBe(201)
    expect(res.json.drop.source).toBe('admin')
    expect(res.json.drop.status).toBe('confirmed')
    expect(res.json.drop.acknowledgment).toBe('pending')
    expect(res.json.drop.amount_requested).toBeNull()
    expect(res.json.drop.balance_before).toBe(1200000)
    expect(res.json.drop.reviewed_by).toBe(adminId)
    expect(typeof res.json.drop.ack_due_at).toBe('number')

    // Persisted: confirmed + watermark + pending ack.
    const row = await getDropRow(res.json.drop.id)
    expect(row?.balance_after).toBe(700000)
    expect(row?.acknowledgment).toBe('pending')

    const me = await getMyBalance(AGENT_EMAIL)
    expect(me.json.balance.balance).toBe(700000)
    expect(me.json.balance.carry_forward).toBe(700000) // the collection is the new anchor
    expect(me.json.balance.last_drop.id).toBe(res.json.drop.id)
    expect(me.json.balance.pending_acknowledgments_count).toBe(1)
    expect(me.json.balance.pending_acknowledgments[0].id).toBe(res.json.drop.id)
    expect(me.json.balance.pending_acknowledgments[0].source).toBe('admin')
  })

  it('S2 — a direct collection can drive the balance negative', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 100000 })

    const res = await registerCollection(ADMIN_EMAIL, { agent_id: agentId, amount: 150000 })
    expect(res.status).toBe(201)
    const me = await getMyBalance(AGENT_EMAIL)
    expect(me.json.balance.balance).toBe(-50000)
  })

  it('S3 — collection against a cross-org / non-agent / unknown target → 404, nothing written', async () => {
    const { organizationId, adminId } = await seedOrgWithStaff()
    // Target the admin (not an agent), and a cross-org agent.
    const { organizationId: orgB } = await seedUser({ email: 'admin-b@empresa.com', role: 'admin', organizationName: 'Org B' })
    const { userId: agentBId } = await seedUser({ email: 'agent-b@empresa.com', role: 'agent', organizationId: orgB })

    expect((await registerCollection(ADMIN_EMAIL, { agent_id: adminId, amount: 100 })).status).toBe(404)
    expect((await registerCollection(ADMIN_EMAIL, { agent_id: agentBId, amount: 100 })).status).toBe(404)
    expect((await registerCollection(ADMIN_EMAIL, { agent_id: crypto.randomUUID(), amount: 100 })).status).toBe(404)
    expect(await countDrops()).toBe(0)
  })

  it('S4 — injected source/status/balance fields are ignored', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 300000 })

    const res = await registerCollection(ADMIN_EMAIL, {
      agent_id: agentId,
      amount: 100000,
      source: 'agent',
      status: 'pending',
      balance_before: 999999,
      organizationId: 'org-x',
    } as Record<string, unknown>)
    expect(res.status).toBe(201)
    const row = await getDropRow(res.json.drop.id)
    expect(row?.source).toBe('admin')
    expect(row?.status).toBe('confirmed')
    expect(row?.balance_before).toBe(300000) // server-derived, not 999999
  })

  it('S4b — invalid collection body → 400', async () => {
    const { agentId } = await seedOrgWithStaff()
    for (const body of [{ agent_id: agentId, amount: 0 }, { agent_id: agentId, amount: -1 }, { amount: 100 }]) {
      const res = await registerCollection(ADMIN_EMAIL, body)
      expect(res.status).toBe(400)
      expect(errCode(res.json)).toBe('VALIDATION_ERROR')
    }
  })

  // -------------------------------------------------------------------------
  // US-A28 — adjusted confirm owes a signature
  // -------------------------------------------------------------------------
  it('S5 — confirming with an adjusted amount sets acknowledgment=pending', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 813000 })
    const dropId = await seedDrop({ organizationId, agentId, amount: 500000, balanceBefore: 813000, status: 'pending' })

    const review = await reviewDrop(ADMIN_EMAIL, dropId, { decision: 'confirmed', amount: 480000 })
    expect(review.status).toBe(200)
    expect(review.json.drop.acknowledgment).toBe('pending')
    expect(review.json.drop.amount_requested).toBe(500000)

    const me = await getMyBalance(AGENT_EMAIL)
    expect(me.json.balance.balance).toBe(333000) // 813000 − 480000 (adjusted)
    expect(me.json.balance.pending_acknowledgments_count).toBe(1)
  })

  it('S6 — confirming as requested owes no signature', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 813000 })
    const dropId = await seedDrop({ organizationId, agentId, amount: 500000, balanceBefore: 813000, status: 'pending' })

    const review = await reviewDrop(ADMIN_EMAIL, dropId, { decision: 'confirmed' })
    expect(review.json.drop.acknowledgment).toBe('not_required')
    const me = await getMyBalance(AGENT_EMAIL)
    expect(me.json.balance.pending_acknowledgments_count).toBe(0)
  })

  it('S7 — rejecting owes no signature and never moves the balance', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 813000 })
    const dropId = await seedDrop({ organizationId, agentId, amount: 500000, balanceBefore: 813000, status: 'pending' })

    const review = await reviewDrop(ADMIN_EMAIL, dropId, { decision: 'rejected', note: 'Short' })
    expect(review.json.drop.acknowledgment).toBe('not_required')
    expect((await getMyBalance(AGENT_EMAIL)).json.balance.balance).toBe(813000)
  })

  // -------------------------------------------------------------------------
  // US-AG27/AG28 — sign or dispute
  // -------------------------------------------------------------------------
  it('S8 — agent signs a pending obligation → signed, leaves the queue, balance unchanged', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 800000 })
    const collection = await registerCollection(ADMIN_EMAIL, { agent_id: agentId, amount: 300000 })
    const dropId = collection.json.drop.id

    const before = await getMyBalance(AGENT_EMAIL)
    expect(before.json.balance.pending_acknowledgments_count).toBe(1)

    const sign = await acknowledgeDrop(AGENT_EMAIL, dropId)
    expect(sign.status).toBe(200)
    expect(sign.json.drop.acknowledgment).toBe('signed')
    expect(typeof sign.json.drop.acknowledged_at).toBe('number')

    const after = await getMyBalance(AGENT_EMAIL)
    expect(after.json.balance.pending_acknowledgments_count).toBe(0)
    expect(after.json.balance.balance).toBe(before.json.balance.balance) // S14 — inert
  })

  it('S9 — agent disputes (with reason) → disputed, no auto-sign, balance unchanged', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 800000 })
    const collection = await registerCollection(ADMIN_EMAIL, { agent_id: agentId, amount: 300000 })
    const dropId = collection.json.drop.id

    const before = await getMyBalance(AGENT_EMAIL)
    const dispute = await disputeDrop(AGENT_EMAIL, dropId, { note: 'Solo entregué 2500' })
    expect(dispute.status).toBe(200)
    expect(dispute.json.drop.acknowledgment).toBe('disputed')
    expect(dispute.json.drop.ack_note).toBe('Solo entregué 2500')

    const row = await getDropRow(dropId)
    expect(row?.acknowledgment).toBe('disputed')

    const after = await getMyBalance(AGENT_EMAIL)
    // A disputed item is no longer "awaiting signature"; balance is untouched (non-blocking).
    expect(after.json.balance.pending_acknowledgments_count).toBe(0)
    expect(after.json.balance.balance).toBe(before.json.balance.balance)
  })

  it('S10 — disputing with an empty reason → 400', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const collection = await registerCollection(ADMIN_EMAIL, { agent_id: agentId, amount: 100000 })
    const dropId = collection.json.drop.id

    for (const body of [{ note: '' }, { note: '   ' }, {}]) {
      const res = await disputeDrop(AGENT_EMAIL, dropId, body)
      expect(res.status).toBe(400)
      expect(errCode(res.json)).toBe('VALIDATION_ERROR')
    }
  })

  it('S11 — signing or disputing a non-pending item → 409', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    // not_required (a plain confirmed agent drop) and already-signed.
    const notRequired = await seedDrop({ organizationId, agentId, amount: 100000, status: 'confirmed', acknowledgment: 'not_required' })
    const alreadySigned = await seedDrop({ organizationId, agentId, amount: 100000, status: 'confirmed', source: 'admin', acknowledgment: 'signed' })

    expect((await acknowledgeDrop(AGENT_EMAIL, notRequired)).status).toBe(409)
    expect((await acknowledgeDrop(AGENT_EMAIL, alreadySigned)).status).toBe(409)
    expect((await disputeDrop(AGENT_EMAIL, notRequired, { note: 'x' })).status).toBe(409)
  })

  it('S12 — acknowledging / disputing another agent or cross-org drop → 404', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const { userId: agent2Id } = await seedUser({ email: AGENT2_EMAIL, role: 'agent', organizationId })
    const othersDrop = await seedDrop({ organizationId, agentId: agent2Id, amount: 100000, source: 'admin', status: 'confirmed', acknowledgment: 'pending', reviewedAt: nowSec() })

    expect((await acknowledgeDrop(AGENT_EMAIL, othersDrop)).status).toBe(404)
    expect((await disputeDrop(AGENT_EMAIL, othersDrop, { note: 'x' })).status).toBe(404)
    expect((await acknowledgeDrop(AGENT_EMAIL, crypto.randomUUID())).status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // Auto-sign (D2) with configurable window (D4)
  // -------------------------------------------------------------------------
  it('S13 — a pending obligation past the window auto-signs (derived + persisted); a disputed one never does', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const t = nowSec()

    // Pending admin collection reviewed 25h ago (default 24h window) → due.
    const due = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      source: 'admin',
      status: 'confirmed',
      acknowledgment: 'pending',
      reviewedAt: t - 25 * HOUR,
      createdAt: t - 25 * HOUR,
    })
    // Disputed drop, also 25h old — must NOT auto-sign.
    const disputed = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      source: 'admin',
      status: 'confirmed',
      acknowledgment: 'disputed',
      ackNote: 'wrong',
      reviewedAt: t - 25 * HOUR,
      createdAt: t - 25 * HOUR,
    })

    const me = await getMyBalance(AGENT_EMAIL)
    const dueDrop = me.json.balance.drops.find((d: any) => d.id === due)
    const disputedDrop = me.json.balance.drops.find((d: any) => d.id === disputed)
    expect(dueDrop.acknowledgment).toBe('auto_signed')
    expect(disputedDrop.acknowledgment).toBe('disputed')
    expect(me.json.balance.pending_acknowledgments_count).toBe(0)
    // Persisted by the opportunistic sweep on GET /me.
    expect((await getDropRow(due))?.acknowledgment).toBe('auto_signed')
    expect((await getDropRow(disputed))?.acknowledgment).toBe('disputed')
  })

  it('S13b — the auto-sign window is configurable per org', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const t = nowSec()
    // Reviewed 30h ago.
    const drop = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      source: 'admin',
      status: 'confirmed',
      acknowledgment: 'pending',
      reviewedAt: t - 30 * HOUR,
      createdAt: t - 30 * HOUR,
    })

    // With a 48h window, 30h is still within the window → effective pending.
    await setAckWindow(organizationId, 48)
    let me = await getMyBalance(AGENT_EMAIL)
    expect(me.json.balance.drops.find((d: any) => d.id === drop).acknowledgment).toBe('pending')
    expect(me.json.balance.pending_acknowledgments_count).toBe(1)

    // Shrink to 12h → now past due → auto-signs.
    await setAckWindow(organizationId, 12)
    me = await getMyBalance(AGENT_EMAIL)
    expect(me.json.balance.drops.find((d: any) => d.id === drop).acknowledgment).toBe('auto_signed')
  })

  it('S13c — once effectively auto-signed, sign/dispute are rejected (409) even before the sweep', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const t = nowSec()
    // Raw status still 'pending' in the DB, but past the window → effectively auto-signed.
    const drop = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      source: 'admin',
      status: 'confirmed',
      acknowledgment: 'pending',
      reviewedAt: t - 48 * HOUR,
      createdAt: t - 48 * HOUR,
    })

    expect((await acknowledgeDrop(AGENT_EMAIL, drop)).status).toBe(409)
    expect((await disputeDrop(AGENT_EMAIL, drop, { note: 'late' })).status).toBe(409)
  })

  // -------------------------------------------------------------------------
  // US-A27/A28 (D5) — admin resolves a dispute
  // -------------------------------------------------------------------------
  it('S15 — admin resolves a dispute → resolved + audited, balance unchanged', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 800000 })
    const collection = await registerCollection(ADMIN_EMAIL, { agent_id: agentId, amount: 300000, note: 'ruta' })
    const dropId = collection.json.drop.id
    await disputeDrop(AGENT_EMAIL, dropId, { note: 'No coincide' })

    const before = await getMyBalance(AGENT_EMAIL)

    const resolved = await resolveDispute(ADMIN_EMAIL, dropId, { note: 'Verificado, monto correcto' })
    expect(resolved.status).toBe(200)
    expect(resolved.json.drop.acknowledgment).toBe('resolved')
    expect(resolved.json.drop.ack_resolved_by).toBe(adminId)
    expect(resolved.json.drop.review_note).toContain('Resolución: Verificado, monto correcto')

    const after = await getMyBalance(AGENT_EMAIL)
    expect(after.json.balance.balance).toBe(before.json.balance.balance) // inert
  })

  it('S16 — resolving a non-disputed drop → 409; empty note → 400; cross-org → 404', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const collection = await registerCollection(ADMIN_EMAIL, { agent_id: agentId, amount: 100000 })
    const pendingId = collection.json.drop.id // pending ack, not disputed

    expect((await resolveDispute(ADMIN_EMAIL, pendingId, { note: 'x' })).status).toBe(409)

    await disputeDrop(AGENT_EMAIL, pendingId, { note: 'reason' })
    expect((await resolveDispute(ADMIN_EMAIL, pendingId, { note: '' })).status).toBe(400)

    // Cross-org admin cannot resolve.
    const { organizationId: orgB } = await seedUser({ email: 'admin-b@empresa.com', role: 'admin', organizationName: 'Org B' })
    void orgB
    expect((await resolveDispute('admin-b@empresa.com', pendingId, { note: 'x' })).status).toBe(404)
  })

  it('S17 — a compensating payout corrects a resolved-in-favour dispute; the drop stays frozen', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const t = nowSec()
    // Anchor the collection 100s in the past so the later compensating payout sits strictly
    // after it on the settlement timeline (the shift derivation counts events created AFTER the
    // anchor's reviewed_at).
    await seedFolio({ organizationId, agentId, amountPaid: 800000, createdAt: t - 200 })
    const dropId = await seedDrop({
      organizationId,
      agentId,
      amount: 300000,
      balanceBefore: 800000,
      balanceAfter: 500000,
      source: 'admin',
      status: 'confirmed',
      acknowledgment: 'pending',
      reviewedBy: adminId,
      reviewedAt: t - 100,
      createdAt: t - 100,
    })
    await disputeDrop(AGENT_EMAIL, dropId, { note: 'Over by 30' })
    await resolveDispute(ADMIN_EMAIL, dropId, { note: 'Agreed; refunding 300 via payout' })

    const mid = await getMyBalance(AGENT_EMAIL)
    expect(mid.json.balance.balance).toBe(500000) // 800000 − 300000

    // Compensating payout (now, strictly after the anchor) raises the balance; the original
    // collection is untouched/frozen.
    const payout = await registerPayout(ADMIN_EMAIL, { agent_id: agentId, amount: 30000 })
    expect(payout.status).toBe(201)
    const after = await getMyBalance(AGENT_EMAIL)
    expect(after.json.balance.balance).toBe(530000)
    expect((await getDropRow(dropId))?.acknowledgment).toBe('resolved')
    expect((await getDropRow(dropId))?.amount).toBe(300000) // never rewritten
  })

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------
  it('S18 — wrong role on the new routes → 403', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const drop = await seedDrop({ organizationId, agentId, amount: 100000, source: 'admin', status: 'confirmed', acknowledgment: 'pending', reviewedAt: nowSec() })

    // Agent cannot direct-collect or resolve disputes.
    expect((await registerCollection(AGENT_EMAIL, { agent_id: agentId, amount: 100 })).status).toBe(403)
    expect((await resolveDispute(AGENT_EMAIL, drop, { note: 'x' })).status).toBe(403)
    // Admin cannot sign/dispute on the agent surface.
    expect((await acknowledgeDrop(ADMIN_EMAIL, drop)).status).toBe(403)
    expect((await disputeDrop(ADMIN_EMAIL, drop, { note: 'x' })).status).toBe(403)
  })

  // -------------------------------------------------------------------------
  // Multitenancy isolation (required — seedTwoOrgs)
  // -------------------------------------------------------------------------
  it('S19 — cross-org collections, resolutions, signatures and disputes are unreachable', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { userId: agentAId } = await seedUser({ email: 'agent-a@empresa.com', role: 'agent', organizationId: orgA.organizationId })
    const { userId: agentBId } = await seedUser({ email: 'agent-b2@empresa.com', role: 'agent', organizationId: orgB.organizationId })

    // Org-B admin cannot collect from an Org-A agent.
    expect((await registerCollection(orgB.adminEmail, { agent_id: agentAId, amount: 1000 })).status).toBe(404)

    // Org-A has a disputed admin collection; Org-B must not see or resolve it.
    const dropA = await seedDrop({
      organizationId: orgA.organizationId,
      agentId: agentAId,
      amount: 50000,
      source: 'admin',
      status: 'confirmed',
      acknowledgment: 'disputed',
      ackNote: 'A reason',
      reviewedAt: nowSec(),
    })
    expect((await resolveDispute(orgB.adminEmail, dropA, { note: 'x' })).status).toBe(404)
    const disputesB = await listDrops(orgB.adminEmail, 'ack=disputed&status=all')
    expect(disputesB.json.drops.map((d: any) => d.id)).not.toContain(dropA)

    // Org-A admin DOES see it in the disputes queue.
    const disputesA = await listDrops(orgA.adminEmail, 'ack=disputed&status=all')
    expect(disputesA.json.drops.map((d: any) => d.id)).toContain(dropA)

    // An Org-A agent cannot acknowledge/dispute an Org-B drop.
    const dropB = await seedDrop({
      organizationId: orgB.organizationId,
      agentId: agentBId,
      amount: 50000,
      source: 'admin',
      status: 'confirmed',
      acknowledgment: 'pending',
      reviewedAt: nowSec(),
    })
    expect((await acknowledgeDrop('agent-a@empresa.com', dropB)).status).toBe(404)
    expect((await disputeDrop('agent-a@empresa.com', dropB, { note: 'x' })).status).toBe(404)
    expect((await getDropRow(dropB))?.acknowledgment).toBe('pending') // untouched
  })
})
