import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Agent Continuous Cash Balance with Cash Drops — US-AG12, AG13, AG14, A19, AG23/24, A25/26.
// Spec: docs/cash-drops/agent-balance-cash-drops.spec.md
//
// The headline running balance is server-derived from events (collected − commissions −
// expenses − confirmed drops + payouts), never stored. The AGENT'S /me breakdown is
// SHIFT-SCOPED: carry_forward + (collected − commissions − expenses) counts only events since
// the agent's last confirmed drop (the anchor); carry_forward is the balancing term that
// reconciles the breakdown to the authoritative all-time `balance`. A cash drop is the
// settlement event (pending → confirmed | rejected). The admin /balances view stays all-time
// (company exposure). Multitenancy isolation uses the shared `seedTwoOrgs` helper.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'
const AGENT2_EMAIL = 'agent2@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const CASH = 'http://api.local/api/cash'
const nowSec = () => Math.floor(Date.now() / 1000)

// --- Local seeders (raw D1) ------------------------------------------------

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  amountPaid: number
  paymentMethod?: 'cash' | 'card'
  commissionAmount?: number
  cancellationClawback?: boolean
  cancelledAt?: number
  createdAt?: number
}

const seedFolio = async ({
  organizationId,
  agentId,
  status = 'paid',
  amountPaid,
  paymentMethod = 'cash',
  commissionAmount = 0,
  cancellationClawback = false,
  cancelledAt,
  createdAt,
}: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = createdAt ?? nowSec()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, status, payment_method,
        subtotal, discount_total, total, amount_paid, commission_amount,
        cancellation_clawback, cancelled_at, created_at, updated_at)
     VALUES (?, ?, ?, 'John Diver', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      agentId,
      status,
      paymentMethod,
      amountPaid,
      amountPaid,
      amountPaid,
      commissionAmount,
      cancellationClawback ? 1 : 0,
      cancelledAt ?? null,
      ts,
      ts,
    )
    .run()
  return id
}

const seedExpense = async (opts: {
  organizationId: string
  agentId: string
  description?: string
  amount: number
  createdAt?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = opts.createdAt ?? nowSec()
  await env.DB.prepare(
    `INSERT INTO agent_expenses (id, organization_id, agent_id, description, amount, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, opts.organizationId, opts.agentId, opts.description ?? 'Gasoline', opts.amount, ts)
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
  note?: string | null
  reviewedBy?: string | null
  reviewedAt?: number | null
  reviewNote?: string | null
  createdAt?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = opts.createdAt ?? nowSec()
  await env.DB.prepare(
    `INSERT INTO cash_drops
       (id, organization_id, agent_id, amount, balance_before, balance_after, status, note,
        reviewed_by, reviewed_at, review_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.organizationId,
      opts.agentId,
      opts.amount,
      opts.balanceBefore ?? 0,
      opts.balanceAfter ?? null,
      opts.status ?? 'pending',
      opts.note ?? null,
      opts.reviewedBy ?? null,
      opts.reviewedAt ?? null,
      opts.reviewNote ?? null,
      ts,
      ts,
    )
    .run()
  return id
}

// --- Row reads (assert persisted state) ------------------------------------

const getDropRow = (id: string) =>
  env.DB.prepare(
    `SELECT organization_id, agent_id, amount, balance_before, status, note, reviewed_by, review_note
       FROM cash_drops WHERE id = ?`,
  )
    .bind(id)
    .first<{
      organization_id: string
      agent_id: string
      amount: number
      balance_before: number
      status: string
      note: string | null
      reviewed_by: string | null
      review_note: string | null
    }>()

const getExpenseRow = (id: string) =>
  env.DB.prepare(
    `SELECT organization_id, agent_id, amount, description FROM agent_expenses WHERE id = ?`,
  )
    .bind(id)
    .first<{ organization_id: string; agent_id: string; amount: number; description: string }>()

const countExpenses = async () =>
  Number(
    (await env.DB.prepare(`SELECT count(*) AS c FROM agent_expenses`).first<{ c: number }>())?.c ?? 0,
  )

const countDrops = async () =>
  Number((await env.DB.prepare(`SELECT count(*) AS c FROM cash_drops`).first<{ c: number }>())?.c ?? 0)

// --- API helpers -----------------------------------------------------------

const getMyBalance = async (email: string) => {
  const res = await SELF.fetch(`${CASH}/me`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const addExpense = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/me/expenses`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const deleteExpense = async (email: string, id: string) => {
  const res = await SELF.fetch(`${CASH}/me/expenses/${id}`, { method: 'DELETE', headers: auth(email) })
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
const cancelDrop = async (email: string, id: string) => {
  const res = await SELF.fetch(`${CASH}/me/drops/${id}`, { method: 'DELETE', headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const listBalances = async (email: string) => {
  const res = await SELF.fetch(`${CASH}/balances`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const listDrops = async (email: string, query = '') => {
  const res = await SELF.fetch(`${CASH}/drops${query ? `?${query}` : ''}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const getDrop = async (email: string, id: string) => {
  const res = await SELF.fetch(`${CASH}/drops/${id}`, { headers: auth(email) })
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
const registerPayout = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/payouts`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const errCode = (json: any): string => json.error?.code ?? json.code

// Seed one org with an admin (the reviewer) + an agent (the cash holder).
const seedOrgWithStaff = async () => {
  const { organizationId, userId: adminId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const { userId: agentId } = await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  return { organizationId, adminId, agentId }
}

// A standard "current shift" fixture: a prior shift settled by a confirmed anchor drop that
// left `carry_forward` behind, then fresh activity since. Returns the anchor's id.
//   pre-drop cash 513000 → balance 513000 at the drop → drop 500000 confirmed → carry 13000
//   since: cash 845000 (commission 84500) + expense 32000 → balance 741500
const seedShiftWithAnchor = async (organizationId: string, adminId: string, agentId: string) => {
  const t = nowSec()
  await seedFolio({ organizationId, agentId, amountPaid: 513000, createdAt: t - 200 })
  const anchorId = await seedDrop({
    organizationId,
    agentId,
    amount: 500000,
    balanceBefore: 513000,
    status: 'confirmed',
    reviewedBy: adminId,
    reviewedAt: t - 100,
    createdAt: t - 100,
  })
  await seedFolio({ organizationId, agentId, amountPaid: 845000, commissionAmount: 84500, createdAt: t })
  await seedExpense({ organizationId, agentId, description: 'Gasoline', amount: 32000, createdAt: t })
  return anchorId
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
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('Agent Continuous Cash Balance with Cash Drops', () => {
  // -------------------------------------------------------------------------
  // US-AG12 — Running balance (shift-scoped breakdown)
  // -------------------------------------------------------------------------
  it('Scenario 1 — breakdown is scoped to the current shift, with a carry-forward line', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const anchorId = await seedShiftWithAnchor(organizationId, adminId, agentId)

    const { status, json } = await getMyBalance(AGENT_EMAIL)
    expect(status).toBe(200)
    expect(json.balance.carry_forward).toBe(13000) // 513000 − 500000 left by the anchor
    expect(json.balance.cash_collected).toBe(845000) // since the anchor only
    expect(json.balance.commission_total).toBe(84500)
    expect(json.balance.expense_total).toBe(32000)
    expect(json.balance.pending_drops_total).toBe(0)
    expect(json.balance.balance).toBe(741500) // 13000 + 845000 − 84500 − 32000
    // The breakdown reconciles to the authoritative all-time balance.
    expect(
      json.balance.carry_forward +
        json.balance.cash_collected -
        json.balance.commission_total -
        json.balance.expense_total,
    ).toBe(json.balance.balance)
    // last_drop identifies the anchor; expenses/drops are the shift's.
    expect(json.balance.last_drop.id).toBe(anchorId)
    expect(json.balance.last_drop.amount).toBe(500000)
    expect(json.balance.last_drop.balance_before).toBe(513000)
    expect(json.balance.expenses).toHaveLength(1) // only the post-anchor expense
    expect(json.balance.drops).toHaveLength(1)
  })

  it('Scenario 2 — no confirmed drop yet → carry-forward is zero, breakdown spans all history', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 200000, commissionAmount: 20000 })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.carry_forward).toBe(0)
    expect(json.balance.last_drop).toBeNull()
    expect(json.balance.cash_collected).toBe(200000)
    expect(json.balance.commission_total).toBe(20000)
    expect(json.balance.balance).toBe(180000) // whole history is the current shift
  })

  it('Scenario 3 — a pending drop does not change the balance, and is not a new anchor', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    await seedShiftWithAnchor(organizationId, adminId, agentId)
    // A pending drop registered after the anchor: reported, not netted, not anchoring.
    await seedDrop({ organizationId, agentId, amount: 100000, status: 'pending' })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.pending_drops_total).toBe(100000)
    expect(json.balance.balance).toBe(741500) // unchanged by the pending drop
    expect(json.balance.carry_forward).toBe(13000) // anchor is still the confirmed drop
    expect(json.balance.cash_collected).toBe(845000)
  })

  it('Scenario 4 — cancelling a pre-anchor folio is absorbed by carry-forward; balance can go negative', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const t = nowSec()
    // The only collection is a pre-anchor folio that is then cancelled; nothing since the drop.
    await seedFolio({ organizationId, agentId, status: 'cancelled', amountPaid: 200000, createdAt: t - 200 })
    await seedDrop({
      organizationId,
      agentId,
      amount: 200000,
      balanceBefore: 200000,
      status: 'confirmed',
      reviewedBy: adminId,
      reviewedAt: t - 100,
      createdAt: t - 100,
    })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.cash_collected).toBe(0) // nothing this shift
    expect(json.balance.carry_forward).toBe(-200000) // prior-shift cancellation lands here
    expect(json.balance.balance).toBe(-200000) // company owes the agent — valid signal
  })

  // Phase-4 (TECH_DEBT §12a): with a WATERMARKED anchor (endpoint-confirmed), cancelling a
  // pre-watermark folio AFTER the drop must NOT rewrite the frozen snapshot. Instead it reverses
  // into the current shift (cash_collected / commission_total drop), the balance stays correct,
  // and the watermark headline still matches the all-time recompute.
  it('Scenario 4a — a settled folio cancelled this shift reverses live; watermark stays frozen', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const t = nowSec()

    // Pre-shift cash folio (live at confirm): balance 600000 − 60000 = 540000.
    const folioId = await seedFolio({
      organizationId,
      agentId,
      amountPaid: 600000,
      commissionAmount: 60000,
      createdAt: t - 500,
    })

    // Confirm a drop through the endpoint → balance_after = 540000 − 100000 = 440000.
    const drop = await createDrop(AGENT_EMAIL, { amount: 100000 })
    expect(
      (await reviewDrop(ADMIN_EMAIL, drop.json.drop.id, { decision: 'confirmed' })).status,
    ).toBe(200)

    // Now the settled folio is cancelled WITH clawback, dated after the watermark.
    await env.DB.prepare(
      `UPDATE folios SET status='cancelled', cancellation_clawback=1, cancelled_at=? WHERE id=?`,
    )
      .bind(t + 500, folioId)
      .run()

    const me = await getMyBalance(AGENT_EMAIL)
    // The watermark is untouched; the reversal lands in the current shift.
    expect(me.json.balance.carry_forward).toBe(440000)
    expect(me.json.balance.cash_collected).toBe(-600000) // collected cash reversed
    expect(me.json.balance.commission_total).toBe(-60000) // clawed-back commission reversed
    // balance = 440000 + (−600000) − (−60000) = −100000
    expect(me.json.balance.balance).toBe(-100000)

    // Regression gate still holds: watermark headline === all-time grouped recompute.
    const balances = await listBalances(ADMIN_EMAIL)
    const row = balances.json.balances.find((b: any) => b.agent.id === agentId)
    expect(row.balance).toBe(-100000)
  })

  // -------------------------------------------------------------------------
  // US-AG13 — Operating expenses
  // -------------------------------------------------------------------------
  it('Scenario 5 — register and delete an expense moves the balance', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 100000 })

    const before = await getMyBalance(AGENT_EMAIL)
    expect(before.json.balance.balance).toBe(100000)

    const add = await addExpense(AGENT_EMAIL, { description: 'Gasoline', amount: 32000 })
    expect(add.status).toBe(201)
    const expenseId = add.json.expense.id as string
    expect(add.json.expense.amount).toBe(32000)

    const mid = await getMyBalance(AGENT_EMAIL)
    expect(mid.json.balance.expense_total).toBe(32000)
    expect(mid.json.balance.balance).toBe(68000)

    const del = await deleteExpense(AGENT_EMAIL, expenseId)
    expect(del.status).toBe(200)
    expect(del.json.ok).toBe(true)

    const after = await getMyBalance(AGENT_EMAIL)
    expect(after.json.balance.expense_total).toBe(0)
    expect(after.json.balance.balance).toBe(100000)
    expect(await countExpenses()).toBe(0)
  })

  // Phase-4 (TECH_DEBT §12a): an expense already SETTLED behind a confirmed drop is frozen —
  // deleting it would silently move a number the admin settled against → 409. An expense after
  // the watermark deletes normally.
  it('Scenario 5a — deleting a settled expense → 409; an unsettled one still deletes', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const t = nowSec()

    // A confirmed drop sets the watermark at t − 100.
    await seedDrop({
      organizationId,
      agentId,
      amount: 50000,
      status: 'confirmed',
      reviewedBy: adminId,
      reviewedAt: t - 100,
      createdAt: t - 100,
    })

    // Settled (created before the watermark) vs. current-shift (created after).
    const settledId = await seedExpense({ organizationId, agentId, amount: 10000, createdAt: t - 200 })
    const freshId = await seedExpense({ organizationId, agentId, amount: 20000, createdAt: t })

    const settled = await deleteExpense(AGENT_EMAIL, settledId)
    expect(settled.status).toBe(409)
    expect(errCode(settled.json)).toBe('CONFLICT')

    const fresh = await deleteExpense(AGENT_EMAIL, freshId)
    expect(fresh.status).toBe(200)

    // The settled expense is still there; only the fresh one is gone.
    expect(await countExpenses()).toBe(1)
    expect((await getExpenseRow(settledId))?.amount).toBe(10000)
  })

  it('Scenario 6 — invalid expense → 400, nothing written', async () => {
    await seedOrgWithStaff()

    for (const body of [
      { description: 'X', amount: 0 },
      { description: 'X', amount: -100 },
      { description: 'X', amount: 10.5 },
      { description: '   ', amount: 100 },
      { description: 'X' },
    ]) {
      const res = await addExpense(AGENT_EMAIL, body)
      expect(res.status).toBe(400)
      expect(errCode(res.json)).toBe('VALIDATION_ERROR')
    }
    expect(await countExpenses()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // US-AG14 — Cash drops
  // -------------------------------------------------------------------------
  it('Scenario 7 — creating a drop snapshots balance_before, stays pending, balance unchanged', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 813000 })

    const create = await createDrop(AGENT_EMAIL, { amount: 500000 })
    expect(create.status).toBe(201)
    expect(create.json.drop.status).toBe('pending')
    expect(create.json.drop.balance_before).toBe(813000)
    expect(create.json.drop.amount).toBe(500000)

    const after = await getMyBalance(AGENT_EMAIL)
    expect(after.json.balance.balance).toBe(813000)
    expect(after.json.balance.pending_drops_total).toBe(500000)
    // A pending drop is not an anchor: still no confirmed drop, so carry_forward is 0.
    expect(after.json.balance.carry_forward).toBe(0)
    expect(after.json.balance.last_drop).toBeNull()
  })

  it('Scenario 8 — cancel a pending drop (200); confirmed/rejected → 409; other-agent/unknown → 404', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const { userId: agent2Id } = await seedUser({ email: AGENT2_EMAIL, role: 'agent', organizationId })

    const pendingId = await seedDrop({ organizationId, agentId, amount: 100000, status: 'pending' })
    const confirmedId = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      status: 'confirmed',
      reviewedBy: adminId,
    })
    const rejectedId = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      status: 'rejected',
      reviewedBy: adminId,
    })
    const otherAgentDrop = await seedDrop({ organizationId, agentId: agent2Id, amount: 100000 })

    const ok = await cancelDrop(AGENT_EMAIL, pendingId)
    expect(ok.status).toBe(200)
    expect(ok.json.ok).toBe(true)

    const c1 = await cancelDrop(AGENT_EMAIL, confirmedId)
    expect(c1.status).toBe(409)
    expect(errCode(c1.json)).toBe('CONFLICT')

    const c2 = await cancelDrop(AGENT_EMAIL, rejectedId)
    expect(c2.status).toBe(409)

    const other = await cancelDrop(AGENT_EMAIL, otherAgentDrop)
    expect(other.status).toBe(404)
    const unknown = await cancelDrop(AGENT_EMAIL, crypto.randomUUID())
    expect(unknown.status).toBe(404)

    // Only the pending drop was removed; the rest survive.
    expect(await countDrops()).toBe(3)
  })

  it('Scenario 9 — invalid drop → 400', async () => {
    await seedOrgWithStaff()
    for (const body of [{ amount: 0 }, { amount: -1 }, { amount: 10.5 }, {}]) {
      const res = await createDrop(AGENT_EMAIL, body)
      expect(res.status).toBe(400)
      expect(errCode(res.json)).toBe('VALIDATION_ERROR')
    }
    expect(await countDrops()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // US-A19 — Admin confirms receipt & sees exposure (admin view stays all-time)
  // -------------------------------------------------------------------------
  it('Scenario 10 — admin lists outstanding balances in their org, ordered, with pending rollup', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const { userId: agent2Id } = await seedUser({ email: AGENT2_EMAIL, role: 'agent', organizationId })

    // agent1 → balance 313000, plus a pending drop.
    await seedFolio({ organizationId, agentId, amountPaid: 845000 })
    await seedExpense({ organizationId, agentId, amount: 32000 })
    await seedDrop({ organizationId, agentId, amount: 500000, status: 'confirmed' })
    await seedDrop({ organizationId, agentId, amount: 100000, status: 'pending' })
    // agent2 → balance 200000, no pending.
    await seedFolio({ organizationId, agentId: agent2Id, amountPaid: 200000 })

    // An org_b agent with a balance — must never appear.
    const { organizationId: orgB } = await seedUser({
      email: 'admin-b@empresa.com',
      role: 'admin',
      organizationName: 'Org B',
    })
    const { userId: agentBId } = await seedUser({
      email: 'agent-b@empresa.com',
      role: 'agent',
      organizationId: orgB,
    })
    await seedFolio({ organizationId: orgB, agentId: agentBId, amountPaid: 999000 })

    const { status, json } = await listBalances(ADMIN_EMAIL)
    expect(status).toBe(200)
    expect(json.balances).toHaveLength(2) // only org_a agents (admin excluded)
    // ordered by balance desc — admin exposure is the all-time figure.
    expect(json.balances[0].agent.id).toBe(agentId)
    expect(json.balances[0].balance).toBe(313000)
    expect(json.balances[0].pending_drops_total).toBe(100000)
    expect(json.balances[0].pending_drops_count).toBe(1)
    expect(json.balances[1].agent.id).toBe(agent2Id)
    expect(json.balances[1].balance).toBe(200000)
    // org_b absent
    expect(json.balances.map((b: any) => b.agent.id)).not.toContain(agentBId)
  })

  // US-A19 (upgrade): /balances is SHIFT-SCOPED — each agent's breakdown counts only events
  // since their own last confirmed drop, plus a carry_forward line, mirroring what the agent
  // sees on /me. The headline `balance` stays the all-time figure. This exercises every term
  // across agents at DIFFERENT shift states — an anchored agent (card exclusion, pending
  // rollup), a no-anchor agent with a payout, and a zero-activity agent — and asserts the
  // per-row reconciliation invariant and ordering. `confirmed_drops_total` is gone (always 0
  // in a shift scope; folded into carry_forward).
  it('Scenario 10b — shift-scoped balances span every term across agents (incl. zero-activity)', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const { userId: agent2Id } = await seedUser({ email: AGENT2_EMAIL, role: 'agent', organizationId })
    const { userId: agent3Id } = await seedUser({
      email: 'agent3@empresa.com',
      role: 'agent',
      organizationId,
    })
    const t = nowSec()

    // agent1: a prior shift (cash 500000, commission 50000) settled by a confirmed anchor drop
    // of 300000 (carry_forward = 450000 − 300000 = 150000). Since the anchor: a cash folio, a
    // card folio (commission only, no cash), an expense, and a pending drop.
    //   all-time balance = 700000 − 80000 − 20000 − 300000 = 300000
    await seedFolio({ organizationId, agentId, amountPaid: 500000, commissionAmount: 50000, createdAt: t - 200 })
    await seedDrop({
      organizationId,
      agentId,
      amount: 300000,
      balanceBefore: 450000,
      status: 'confirmed',
      reviewedBy: adminId,
      reviewedAt: t - 100,
      createdAt: t - 100,
    })
    await seedFolio({ organizationId, agentId, amountPaid: 200000, commissionAmount: 20000, createdAt: t })
    await seedFolio({
      organizationId,
      agentId,
      amountPaid: 100000,
      paymentMethod: 'card',
      commissionAmount: 10000,
      createdAt: t,
    })
    await seedExpense({ organizationId, agentId, amount: 20000, createdAt: t })
    await seedDrop({ organizationId, agentId, amount: 80000, status: 'pending', createdAt: t })

    // agent2: no confirmed drop → carry_forward 0, breakdown spans all history. A cash folio
    // plus a payout (raises the balance). balance = 200000 + 30000 = 230000.
    await seedFolio({ organizationId, agentId: agent2Id, amountPaid: 200000 })
    await registerPayout(ADMIN_EMAIL, { agent_id: agent2Id, amount: 30000 })

    // agent3: no activity at all → must still appear, with an all-zero row.

    const { status, json } = await listBalances(ADMIN_EMAIL)
    expect(status).toBe(200)
    expect(json.balances).toHaveLength(3)

    // Ordered by balance desc.
    const [b1, b2, b3] = json.balances
    expect(b1.agent.id).toBe(agentId)
    expect(b1.carry_forward).toBe(150000) // 450000 left by the prior shift − 300000 dropped
    expect(b1.cash_collected).toBe(200000) // since the anchor only; card excluded
    expect(b1.commission_total).toBe(30000) // cash + card folios since the anchor
    expect(b1.expense_total).toBe(20000)
    expect(b1.payouts_total).toBe(0)
    expect(b1.balance).toBe(300000) // all-time headline, unchanged
    expect(b1.last_drop.amount).toBe(300000) // the anchor
    expect(b1.pending_drops_total).toBe(80000) // reported, not netted into balance
    expect(b1.pending_drops_count).toBe(1)
    expect(b1.confirmed_drops_total).toBeUndefined() // retired in the shift scope
    // Per-row reconciliation: the shift breakdown sums back to the all-time balance.
    expect(
      b1.carry_forward + b1.cash_collected - b1.commission_total - b1.expense_total + b1.payouts_total,
    ).toBe(b1.balance)

    expect(b2.agent.id).toBe(agent2Id)
    expect(b2.carry_forward).toBe(0) // no anchor → whole history is the current shift
    expect(b2.last_drop).toBeNull()
    expect(b2.cash_collected).toBe(200000)
    expect(b2.payouts_total).toBe(30000)
    expect(b2.balance).toBe(230000)
    expect(b2.pending_drops_total).toBe(0)

    expect(b3.agent.id).toBe(agent3Id)
    expect(b3.balance).toBe(0)
    expect(b3.carry_forward).toBe(0)
    expect(b3.cash_collected).toBe(0)
    expect(b3.last_drop).toBeNull()
    expect(b3.pending_drops_count).toBe(0)
  })

  // US-A19 (upgrade): each agent's dashboard row is scoped to its OWN watermark — no bleed
  // across agents at different shift states. Both drops here are confirmed THROUGH the endpoint
  // (so they carry a balance_after watermark and exercise the fast path via /balances), at
  // clearly separated instants, with post-watermark activity on each.
  it('Scenario 10c — each row is scoped to its own watermark; no cross-agent bleed', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const { userId: agent2Id } = await seedUser({ email: AGENT2_EMAIL, role: 'agent', organizationId })
    const t = nowSec()

    // agent1: collect 400000, drop 250000 (endpoint-confirmed → watermark 150000), then collect
    // 100000 since. balance = 150000 + 100000 = 250000.
    await seedFolio({ organizationId, agentId, amountPaid: 400000, createdAt: t - 300 })
    const d1 = await createDrop(AGENT_EMAIL, { amount: 250000 })
    expect((await reviewDrop(ADMIN_EMAIL, d1.json.drop.id, { decision: 'confirmed' })).status).toBe(200)
    await seedFolio({ organizationId, agentId, amountPaid: 100000, createdAt: t + 300 })

    // agent2: collect 600000, drop 600000 (endpoint-confirmed → watermark 0), nothing since.
    // balance = 0; the breakdown must be empty, NOT show agent1's numbers.
    await seedFolio({ organizationId, agentId: agent2Id, amountPaid: 600000, createdAt: t - 300 })
    const d2 = await createDrop(AGENT2_EMAIL, { amount: 600000 })
    expect((await reviewDrop(ADMIN_EMAIL, d2.json.drop.id, { decision: 'confirmed' })).status).toBe(200)

    const { json } = await listBalances(ADMIN_EMAIL)
    const r1 = json.balances.find((b: any) => b.agent.id === agentId)
    const r2 = json.balances.find((b: any) => b.agent.id === agent2Id)

    expect(r1.carry_forward).toBe(150000) // watermark read directly
    expect(r1.cash_collected).toBe(100000) // only the post-watermark folio
    expect(r1.balance).toBe(250000)

    expect(r2.carry_forward).toBe(0) // dropped to zero
    expect(r2.cash_collected).toBe(0) // nothing since its watermark — no bleed from agent1
    expect(r2.balance).toBe(0)
  })

  it('Scenario 11 — admin lists and reads the pending drops queue (default pending)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const older = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      balanceBefore: 300000,
      note: 'first',
      createdAt: nowSec() - 100,
    })
    const newer = await seedDrop({
      organizationId,
      agentId,
      amount: 200000,
      balanceBefore: 500000,
      note: 'End of Saturday route',
      createdAt: nowSec(),
    })
    // A confirmed drop must be hidden by the default pending filter.
    await seedDrop({ organizationId, agentId, amount: 50000, status: 'confirmed' })

    const { status, json } = await listDrops(ADMIN_EMAIL)
    expect(status).toBe(200)
    expect(json.drops).toHaveLength(2)
    // newest first
    expect(json.drops[0].id).toBe(newer)
    expect(json.drops[0].agent.id).toBe(agentId)
    expect(json.drops[0].amount).toBe(200000)
    expect(json.drops[0].balance_before).toBe(500000)
    expect(json.drops[0].note).toBe('End of Saturday route')
    expect(json.drops[1].id).toBe(older)

    const detail = await getDrop(ADMIN_EMAIL, newer)
    expect(detail.status).toBe(200)
    expect(detail.json.drop.id).toBe(newer)
    expect(detail.json.drop.agent.id).toBe(agentId)
    expect(detail.json.drop.amount).toBe(200000)
  })

  it('Scenario 12 — admin confirms a drop → balance drops, drop becomes the new anchor', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    // The collected cash predates the drop, so confirming it settles that prior shift.
    await seedFolio({ organizationId, agentId, amountPaid: 813000, createdAt: nowSec() - 100 })
    const dropId = await seedDrop({
      organizationId,
      agentId,
      amount: 500000,
      balanceBefore: 813000,
      status: 'pending',
    })

    const review = await reviewDrop(ADMIN_EMAIL, dropId, { decision: 'confirmed' })
    expect(review.status).toBe(200)
    expect(review.json.drop.status).toBe('confirmed')
    expect(review.json.drop.reviewed_by).toBe(adminId)
    expect(typeof review.json.drop.reviewed_at).toBe('number')

    const balance = await getMyBalance(AGENT_EMAIL)
    // The confirmed drop is now the anchor: the prior shift's cash folds into carry_forward.
    expect(balance.json.balance.last_drop.id).toBe(dropId)
    expect(balance.json.balance.carry_forward).toBe(313000) // 813000 − 500000
    expect(balance.json.balance.cash_collected).toBe(0) // nothing since the drop
    expect(balance.json.balance.pending_drops_total).toBe(0)
    expect(balance.json.balance.balance).toBe(313000)
  })

  // Phase-3 REGRESSION GATE (TECH_DEBT §12b): once a drop is confirmed through the endpoint it
  // carries a `balance_after` watermark, so /me derives the headline as `watermark + Σ(since)`
  // (bounded by the shift). That fast-path figure MUST equal the independent all-time recompute
  // that /balances performs (grouped, no watermark). Pre/post-watermark events use clearly
  // separated timestamps so they sit unambiguously on either side of the confirm instant.
  it('Scenario 12a — watermark fast path equals the all-time recompute across a mixed shift', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const t = nowSec()

    // Pre-shift: a cash folio with commission → balance 270000 (300000 − 30000).
    await seedFolio({
      organizationId,
      agentId,
      amountPaid: 300000,
      commissionAmount: 30000,
      createdAt: t - 500,
    })

    // Agent registers a drop; admin confirms it through the endpoint (stamps balance_after).
    // balance_after = 270000 − 200000 = 70000.
    const drop = await createDrop(AGENT_EMAIL, { amount: 200000 })
    const dropId = drop.json.drop.id
    expect((await reviewDrop(ADMIN_EMAIL, dropId, { decision: 'confirmed' })).status).toBe(200)

    // Fresh activity SINCE the watermark (future timestamps → unambiguously after the confirm):
    // another cash folio, a card folio (commission only, no cash), and an expense.
    await seedFolio({
      organizationId,
      agentId,
      amountPaid: 500000,
      commissionAmount: 50000,
      createdAt: t + 500,
    })
    await seedFolio({
      organizationId,
      agentId,
      amountPaid: 100000,
      paymentMethod: 'card',
      commissionAmount: 10000,
      createdAt: t + 500,
    })
    await seedExpense({ organizationId, agentId, amount: 40000, createdAt: t + 500 })

    const me = await getMyBalance(AGENT_EMAIL)
    // Fast path: carry_forward is the watermark, the breakdown is the current shift only.
    expect(me.json.balance.last_drop.id).toBe(dropId)
    expect(me.json.balance.carry_forward).toBe(70000)
    expect(me.json.balance.cash_collected).toBe(500000) // card folio excluded from cash
    expect(me.json.balance.commission_total).toBe(60000) // both since-folios' commission
    expect(me.json.balance.expense_total).toBe(40000)
    // balance = 70000 + 500000 − 60000 − 40000 = 470000
    expect(me.json.balance.balance).toBe(470000)

    // The gate: the admin dashboard row MIRRORS the agent's /me view field-by-field (both now
    // flow through the canonical deriveBalance), and its balance equals the independent all-time
    // recompute (cash 800000 − commission 90000 − expense 40000 − dropped 200000 = 470000).
    const balances = await listBalances(ADMIN_EMAIL)
    const row = balances.json.balances.find((b: any) => b.agent.id === agentId)
    expect(row.balance).toBe(470000) // independent all-time recompute
    expect(row.carry_forward).toBe(me.json.balance.carry_forward)
    expect(row.cash_collected).toBe(me.json.balance.cash_collected)
    expect(row.commission_total).toBe(me.json.balance.commission_total)
    expect(row.expense_total).toBe(me.json.balance.expense_total)
    expect(row.payouts_total).toBe(me.json.balance.payouts_total)
    expect(row.balance).toBe(me.json.balance.balance)
    expect(row.last_drop.id).toBe(me.json.balance.last_drop.id)
  })

  // Phase-3 (TECH_DEBT §12e): the anchor follows the SETTLEMENT timeline (reviewed_at), so a
  // drop created earlier but confirmed later wins — and carry_forward is read directly from its
  // watermark. Seeded with explicit, self-consistent watermarks to isolate anchor selection.
  it('Scenario 12b — anchor is the most recently confirmed drop, carry read from its watermark', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const t = nowSec()

    // Created first, confirmed LAST (greater reviewed_at) → this must be the anchor.
    const lateConfirm = await seedDrop({
      organizationId,
      agentId,
      amount: 200000,
      status: 'confirmed',
      reviewedBy: adminId,
      reviewedAt: t - 10,
      createdAt: t - 100,
      balanceBefore: 900000,
      balanceAfter: 700000,
    })
    // Created later, confirmed EARLIER (smaller reviewed_at).
    await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      status: 'confirmed',
      reviewedBy: adminId,
      reviewedAt: t - 40,
      createdAt: t - 50,
      balanceBefore: 800000,
      balanceAfter: 650000,
    })

    const me = await getMyBalance(AGENT_EMAIL)
    expect(me.json.balance.last_drop.id).toBe(lateConfirm) // confirmed last, not created last
    expect(me.json.balance.carry_forward).toBe(700000) // read straight from balance_after
    expect(me.json.balance.balance).toBe(700000) // no activity since the anchor
  })

  it('Scenario 13 — admin rejects a drop with a note → balance unchanged, note stored', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 813000 })
    const dropId = await seedDrop({
      organizationId,
      agentId,
      amount: 500000,
      balanceBefore: 813000,
      status: 'pending',
    })

    const review = await reviewDrop(ADMIN_EMAIL, dropId, {
      decision: 'rejected',
      note: 'Short by 200.',
    })
    expect(review.status).toBe(200)
    expect(review.json.drop.status).toBe('rejected')
    expect(review.json.drop.review_note).toBe('Short by 200.')

    const row = await getDropRow(dropId)
    expect(row?.status).toBe('rejected')
    expect(row?.review_note).toBe('Short by 200.')

    const balance = await getMyBalance(AGENT_EMAIL)
    // A rejected drop is not an anchor and never reduces the balance.
    expect(balance.json.balance.carry_forward).toBe(0)
    expect(balance.json.balance.last_drop).toBeNull()
    expect(balance.json.balance.balance).toBe(813000)
  })

  it('Scenario 14 — reviewing a non-pending drop → 409', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const confirmedId = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      status: 'confirmed',
      reviewedBy: adminId,
    })
    const rejectedId = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      status: 'rejected',
      reviewedBy: adminId,
    })

    const r1 = await reviewDrop(ADMIN_EMAIL, confirmedId, { decision: 'confirmed' })
    expect(r1.status).toBe(409)
    expect(errCode(r1.json)).toBe('CONFLICT')

    const r2 = await reviewDrop(ADMIN_EMAIL, rejectedId, { decision: 'confirmed' })
    expect(r2.status).toBe(409)

    // statuses unchanged
    expect((await getDropRow(confirmedId))?.status).toBe('confirmed')
    expect((await getDropRow(rejectedId))?.status).toBe('rejected')
  })

  // Phase-2 refinement (TECH_DEBT §12c): adjust-amount-on-confirm. An admin may confirm with a
  // corrected amount instead of forcing reject-and-resubmit.
  it('Scenario 14a — admin confirms with an adjusted amount → audited, balance uses it', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 813000 })
    const dropId = await seedDrop({
      organizationId,
      agentId,
      amount: 500000,
      balanceBefore: 813000,
      status: 'pending',
    })

    const review = await reviewDrop(ADMIN_EMAIL, dropId, {
      decision: 'confirmed',
      amount: 480000,
      note: 'Counted 4800.',
    })
    expect(review.status).toBe(200)
    expect(review.json.drop.status).toBe('confirmed')
    expect(review.json.drop.amount).toBe(480000) // the corrected amount
    expect(review.json.drop.amount_requested).toBe(500000) // the agent's original ask
    // Delta appended to the audit note (alongside the admin's own note).
    expect(review.json.drop.review_note).toContain('Counted 4800.')
    expect(review.json.drop.review_note).toContain('Adjusted from 5000.00 to 4800.00')

    // Persisted amount is the adjusted one.
    expect((await getDropRow(dropId))?.amount).toBe(480000)

    const balance = await getMyBalance(AGENT_EMAIL)
    // The balance reduces by the CONFIRMED (adjusted) amount, not the requested one.
    expect(balance.json.balance.carry_forward).toBe(333000) // 813000 − 480000
    expect(balance.json.balance.balance).toBe(333000)
  })

  it('Scenario 14b — confirming as requested leaves amount_requested null, no audit delta', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 813000 })
    const dropId = await seedDrop({
      organizationId,
      agentId,
      amount: 500000,
      balanceBefore: 813000,
      status: 'pending',
    })

    // Passing amount === the registered amount is a no-op adjustment.
    const review = await reviewDrop(ADMIN_EMAIL, dropId, {
      decision: 'confirmed',
      amount: 500000,
    })
    expect(review.status).toBe(200)
    expect(review.json.drop.amount).toBe(500000)
    expect(review.json.drop.amount_requested).toBeNull()
    expect(review.json.drop.review_note).toBeNull()
  })

  it('Scenario 14c — an adjust amount on REJECT is ignored (amount untouched)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const dropId = await seedDrop({
      organizationId,
      agentId,
      amount: 500000,
      status: 'pending',
    })

    const review = await reviewDrop(ADMIN_EMAIL, dropId, {
      decision: 'rejected',
      amount: 480000, // ignored on reject
      note: 'Short.',
    })
    expect(review.status).toBe(200)
    expect(review.json.drop.status).toBe('rejected')
    expect(review.json.drop.amount).toBe(500000) // unchanged
    expect(review.json.drop.amount_requested).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------
  it('Scenario 15 — wrong role both ways → 403', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const dropId = await seedDrop({ organizationId, agentId, amount: 100000 })

    // agent → admin routes
    expect((await listBalances(AGENT_EMAIL)).status).toBe(403)
    expect((await listDrops(AGENT_EMAIL)).status).toBe(403)
    expect((await getDrop(AGENT_EMAIL, dropId)).status).toBe(403)
    expect((await reviewDrop(AGENT_EMAIL, dropId, { decision: 'confirmed' })).status).toBe(403)

    // admin → /me/* routes
    expect((await getMyBalance(ADMIN_EMAIL)).status).toBe(403)
    expect((await addExpense(ADMIN_EMAIL, { description: 'X', amount: 100 })).status).toBe(403)
    expect((await createDrop(ADMIN_EMAIL, { amount: 100 })).status).toBe(403)
  })

  // -------------------------------------------------------------------------
  // Multitenancy isolation (required — seedTwoOrgs)
  // -------------------------------------------------------------------------
  it('Scenario 16 — B3/B4: cross-org drops/balances invisible and unreachable', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { userId: agentAId } = await seedUser({
      email: 'agent-a@empresa.com',
      role: 'agent',
      organizationId: orgA.organizationId,
    })
    const { userId: agentBId } = await seedUser({
      email: 'agent-b@empresa.com',
      role: 'agent',
      organizationId: orgB.organizationId,
    })

    await seedFolio({ organizationId: orgA.organizationId, agentId: agentAId, amountPaid: 100000 })
    await seedExpense({ organizationId: orgA.organizationId, agentId: agentAId, amount: 5000 })
    const dropA = await seedDrop({ organizationId: orgA.organizationId, agentId: agentAId, amount: 30000 })

    await seedFolio({ organizationId: orgB.organizationId, agentId: agentBId, amountPaid: 999000 })
    await seedExpense({ organizationId: orgB.organizationId, agentId: agentBId, amount: 7000 })
    const dropB = await seedDrop({ organizationId: orgB.organizationId, agentId: agentBId, amount: 40000 })

    // org_a admin balances/drops: only org_a appears.
    const balances = await listBalances(orgA.adminEmail)
    expect(balances.json.balances.map((b: any) => b.agent.id)).toEqual([agentAId])

    const drops = await listDrops(orgA.adminEmail)
    expect(drops.json.drops).toHaveLength(1)
    expect(drops.json.drops[0].id).toBe(dropA)

    // org_b drop unreachable by id, and unreviewable → 404 (no existence leak).
    expect((await getDrop(orgA.adminEmail, dropB)).status).toBe(404)
    const review = await reviewDrop(orgA.adminEmail, dropB, { decision: 'confirmed' })
    expect(review.status).toBe(404)
    expect((await getDropRow(dropB))?.status).toBe('pending') // untouched

    // org_a agent /me sees only their own data.
    const me = await getMyBalance('agent-a@empresa.com')
    expect(me.json.balance.cash_collected).toBe(100000)
    expect(me.json.balance.drops).toHaveLength(1)
    expect(me.json.balance.drops[0].id).toBe(dropA)
  })

  it('Scenario 17 — B1: injected org/agent/status/balance_before are ignored', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const { organizationId: orgB } = await seedUser({
      email: 'admin-b@empresa.com',
      role: 'admin',
      organizationName: 'Org B',
    })
    await seedFolio({ organizationId, agentId, amountPaid: 700000 })

    // Injected expense fields are stripped: row is org_a / caller.
    const exp = await addExpense(AGENT_EMAIL, {
      description: 'Gasoline',
      amount: 32000,
      organizationId: orgB,
      agent_id: 'someone-else',
    } as Record<string, unknown>)
    expect(exp.status).toBe(201)
    const expRow = await getExpenseRow(exp.json.expense.id)
    expect(expRow?.organization_id).toBe(organizationId)
    expect(expRow?.agent_id).toBe(agentId)

    // Injected drop fields are stripped: pending, server-computed balance_before, org_a/caller.
    const drop = await createDrop(AGENT_EMAIL, {
      amount: 500000,
      organizationId: orgB,
      agent_id: 'someone-else',
      status: 'confirmed',
      balance_before: 999999,
    } as Record<string, unknown>)
    expect(drop.status).toBe(201)
    const dropRow = await getDropRow(drop.json.drop.id)
    expect(dropRow?.organization_id).toBe(organizationId)
    expect(dropRow?.agent_id).toBe(agentId)
    expect(dropRow?.status).toBe('pending')
    // balance_before = cash_collected(700000) − commission(0) − expense(32000)
    //                  − confirmed(0) + payouts(0) = 668000, NOT 999999.
    expect(dropRow?.balance_before).toBe(668000)
  })

  // -------------------------------------------------------------------------
  // US-AG23 / US-AG24 — commissions & payment method in the balance
  // -------------------------------------------------------------------------
  it('Scenario 18 — commission reduces a cash balance (US-AG23)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({
      organizationId,
      agentId,
      amountPaid: 300000,
      paymentMethod: 'cash',
      commissionAmount: 30000,
    })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.cash_collected).toBe(300000)
    expect(json.balance.commission_total).toBe(30000)
    // 300000 − 30000 − 0 − 0 + 0
    expect(json.balance.balance).toBe(270000)
  })

  it('Scenario 19 — a card sale earns commission but adds no cash debt (US-AG24)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({
      organizationId,
      agentId,
      amountPaid: 300000,
      paymentMethod: 'card',
      commissionAmount: 30000,
    })

    const { json } = await getMyBalance(AGENT_EMAIL)
    // Card sale: amount_paid is NOT collected as cash, but commission is still earned →
    // the company now owes the agent their commission (balance goes negative).
    expect(json.balance.cash_collected).toBe(0)
    expect(json.balance.commission_total).toBe(30000)
    expect(json.balance.balance).toBe(-30000)
  })

  // -------------------------------------------------------------------------
  // US-A26 — clawback on cancellation
  // -------------------------------------------------------------------------
  it('Scenario 20 — clawback drops the commission; an absorbed loss keeps it (US-A26)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    // Cancelled folio, commission clawed back → excluded from commissions.
    await seedFolio({
      organizationId,
      agentId,
      status: 'cancelled',
      amountPaid: 200000,
      commissionAmount: 50000,
      cancellationClawback: true,
    })

    let me = await getMyBalance(AGENT_EMAIL)
    expect(me.json.balance.cash_collected).toBe(0) // cancelled → not collected
    expect(me.json.balance.commission_total).toBe(0) // clawed back
    expect(me.json.balance.balance).toBe(0)

    // A second cancelled folio the company absorbed (clawback=false) → commission kept,
    // pushing the balance negative (company owes the agent).
    await seedFolio({
      organizationId,
      agentId,
      status: 'cancelled',
      amountPaid: 100000,
      commissionAmount: 30000,
      cancellationClawback: false,
    })

    me = await getMyBalance(AGENT_EMAIL)
    expect(me.json.balance.commission_total).toBe(30000)
    expect(me.json.balance.balance).toBe(-30000)
  })

  it('Scenario 21 — admin cancels with clawback via the API → commission excluded (US-A26)', async () => {
    // Drive the real cancellation handler to assert the clawback flag is persisted and read.
    const { organizationId, agentId } = await seedOrgWithStaff()
    const folioId = await seedFolio({
      organizationId,
      agentId,
      amountPaid: 100000,
      commissionAmount: 20000,
    })

    const before = await getMyBalance(AGENT_EMAIL)
    expect(before.json.balance.balance).toBe(80000) // 100000 − 20000

    const res = await SELF.fetch(`http://api.local/api/folios/${folioId}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'No-show', clawback: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.folio.cancellation_clawback).toBe(true)

    const after = await getMyBalance(AGENT_EMAIL)
    // Folio cancelled (no cash) AND commission clawed back → balance 0.
    expect(after.json.balance.cash_collected).toBe(0)
    expect(after.json.balance.commission_total).toBe(0)
    expect(after.json.balance.balance).toBe(0)
  })

  // -------------------------------------------------------------------------
  // US-A25 — payouts (company → agent)
  // -------------------------------------------------------------------------
  it('Scenario 22 — a payout raises the balance and clears a negative position', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    // Card sale leaves the agent at −30000 (company owes commission).
    await seedFolio({
      organizationId,
      agentId,
      amountPaid: 300000,
      paymentMethod: 'card',
      commissionAmount: 30000,
    })

    const before = await getMyBalance(AGENT_EMAIL)
    expect(before.json.balance.balance).toBe(-30000)

    const payout = await registerPayout(ADMIN_EMAIL, { agent_id: agentId, amount: 30000 })
    expect(payout.status).toBe(201)
    expect(payout.json.payout.agent_id).toBe(agentId)
    expect(payout.json.payout.amount).toBe(30000)

    const after = await getMyBalance(AGENT_EMAIL)
    expect(after.json.balance.payouts_total).toBe(30000)
    expect(after.json.balance.balance).toBe(0)

    // The admin balances view reflects the payout too.
    const balances = await listBalances(ADMIN_EMAIL)
    const row = balances.json.balances.find((b: any) => b.agent.id === agentId)
    expect(row.payouts_total).toBe(30000)
    expect(row.balance).toBe(0)
  })

  it('Scenario 23 — payout to an unknown/cross-org agent → 404; wrong role → 403', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    // org_b agent — must be unreachable for the org_a admin.
    const { organizationId: orgB } = await seedUser({
      email: 'admin-b@empresa.com',
      role: 'admin',
      organizationName: 'Org B',
    })
    const { userId: agentBId } = await seedUser({
      email: 'agent-b@empresa.com',
      role: 'agent',
      organizationId: orgB,
    })

    expect((await registerPayout(ADMIN_EMAIL, { agent_id: crypto.randomUUID(), amount: 100 })).status).toBe(404)
    expect((await registerPayout(ADMIN_EMAIL, { agent_id: agentBId, amount: 100 })).status).toBe(404)

    // An agent may not register payouts.
    expect((await registerPayout(AGENT_EMAIL, { agent_id: agentId, amount: 100 })).status).toBe(403)
    // Invalid amount → 400.
    expect((await registerPayout(ADMIN_EMAIL, { agent_id: agentId, amount: 0 })).status).toBe(400)
  })
})
