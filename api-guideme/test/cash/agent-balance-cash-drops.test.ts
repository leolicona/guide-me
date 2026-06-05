import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Agent Continuous Cash Balance with Cash Drops — US-AG12, AG13, AG14, A19.
// Spec: docs/cash-drops/agent-balance-cash-drops.spec.md (Scenarios 1–16).
//
// The running balance is server-derived from events (collected − expenses − confirmed
// drops), never stored. A cash drop is the settlement event (pending → confirmed | rejected).
// Multitenancy isolation (15–16) uses the shared `seedTwoOrgs` helper.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'
const AGENT2_EMAIL = 'agent2@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const CASH = 'http://api.local/api/cash'

// --- Local seeders (raw D1) ------------------------------------------------

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  amountPaid: number
  paymentMethod?: 'cash' | 'card'
  commissionAmount?: number
  cancellationClawback?: boolean
}

const seedFolio = async ({
  organizationId,
  agentId,
  status = 'paid',
  amountPaid,
  paymentMethod = 'cash',
  commissionAmount = 0,
  cancellationClawback = false,
}: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, status, payment_method,
        subtotal, discount_total, total, amount_paid, commission_amount,
        cancellation_clawback, created_at, updated_at)
     VALUES (?, ?, ?, 'John Diver', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
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
  const ts = opts.createdAt ?? Math.floor(Date.now() / 1000)
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
  status?: 'pending' | 'confirmed' | 'rejected'
  note?: string | null
  reviewedBy?: string | null
  reviewedAt?: number | null
  reviewNote?: string | null
  createdAt?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = opts.createdAt ?? Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO cash_drops
       (id, organization_id, agent_id, amount, balance_before, status, note,
        reviewed_by, reviewed_at, review_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.organizationId,
      opts.agentId,
      opts.amount,
      opts.balanceBefore ?? 0,
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

beforeEach(async () => {
  await env.DB.exec('DELETE FROM payouts')
  await env.DB.exec('DELETE FROM cash_drops')
  await env.DB.exec('DELETE FROM agent_expenses')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
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
  // US-AG12 — Running balance
  // -------------------------------------------------------------------------
  it('Scenario 1 — balance = collected − expenses − confirmed drops', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 845000 })
    await seedExpense({ organizationId, agentId, description: 'Gasoline', amount: 32000 })
    await seedDrop({
      organizationId,
      agentId,
      amount: 500000,
      balanceBefore: 813000,
      status: 'confirmed',
      reviewedBy: adminId,
      reviewedAt: Math.floor(Date.now() / 1000),
    })

    const { status, json } = await getMyBalance(AGENT_EMAIL)
    expect(status).toBe(200)
    expect(json.balance.cash_collected).toBe(845000)
    expect(json.balance.expense_total).toBe(32000)
    expect(json.balance.confirmed_drops_total).toBe(500000)
    expect(json.balance.pending_drops_total).toBe(0)
    expect(json.balance.balance).toBe(313000)
    expect(json.balance.expenses).toHaveLength(1)
    expect(json.balance.drops).toHaveLength(1)
  })

  it('Scenario 2 — a pending drop is reported, not netted out', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 845000 })
    await seedExpense({ organizationId, agentId, amount: 32000 })
    await seedDrop({
      organizationId,
      agentId,
      amount: 500000,
      status: 'confirmed',
      reviewedBy: adminId,
    })
    await seedDrop({ organizationId, agentId, amount: 100000, status: 'pending' })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.confirmed_drops_total).toBe(500000)
    expect(json.balance.pending_drops_total).toBe(100000)
    expect(json.balance.balance).toBe(313000)
  })

  it('Scenario 3 — cancelled folios excluded; balance can go negative', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, status: 'cancelled', amountPaid: 200000 })
    await seedDrop({
      organizationId,
      agentId,
      amount: 200000,
      status: 'confirmed',
      reviewedBy: adminId,
    })

    const { json } = await getMyBalance(AGENT_EMAIL)
    expect(json.balance.cash_collected).toBe(0)
    expect(json.balance.balance).toBe(-200000)
  })

  // -------------------------------------------------------------------------
  // US-AG13 — Operating expenses
  // -------------------------------------------------------------------------
  it('Scenario 4 — register and delete an expense moves the balance', async () => {
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

  it('Scenario 5 — invalid expense → 400, nothing written', async () => {
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
  it('Scenario 6 — creating a drop snapshots balance_before, stays pending, balance unchanged', async () => {
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
    expect(after.json.balance.confirmed_drops_total).toBe(0)
  })

  it('Scenario 7 — cancel a pending drop (200); confirmed/rejected → 409; other-agent/unknown → 404', async () => {
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

  it('Scenario 8 — invalid drop → 400', async () => {
    await seedOrgWithStaff()
    for (const body of [{ amount: 0 }, { amount: -1 }, { amount: 10.5 }, {}]) {
      const res = await createDrop(AGENT_EMAIL, body)
      expect(res.status).toBe(400)
      expect(errCode(res.json)).toBe('VALIDATION_ERROR')
    }
    expect(await countDrops()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // US-A19 — Admin confirms receipt & sees exposure
  // -------------------------------------------------------------------------
  it('Scenario 9 — admin lists outstanding balances in their org, ordered, with pending rollup', async () => {
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
    // ordered by balance desc
    expect(json.balances[0].agent.id).toBe(agentId)
    expect(json.balances[0].balance).toBe(313000)
    expect(json.balances[0].pending_drops_total).toBe(100000)
    expect(json.balances[0].pending_drops_count).toBe(1)
    expect(json.balances[1].agent.id).toBe(agent2Id)
    expect(json.balances[1].balance).toBe(200000)
    // org_b absent
    expect(json.balances.map((b: any) => b.agent.id)).not.toContain(agentBId)
  })

  it('Scenario 10 — admin lists and reads the pending drops queue (default pending)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const older = await seedDrop({
      organizationId,
      agentId,
      amount: 100000,
      balanceBefore: 300000,
      note: 'first',
      createdAt: Math.floor(Date.now() / 1000) - 100,
    })
    const newer = await seedDrop({
      organizationId,
      agentId,
      amount: 200000,
      balanceBefore: 500000,
      note: 'End of Saturday route',
      createdAt: Math.floor(Date.now() / 1000),
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

  it('Scenario 11 — admin confirms a drop → balance drops; reviewed_by/at set', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 813000 })
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
    expect(balance.json.balance.confirmed_drops_total).toBe(500000)
    expect(balance.json.balance.pending_drops_total).toBe(0)
    expect(balance.json.balance.balance).toBe(313000)
  })

  it('Scenario 12 — admin rejects a drop with a note → balance unchanged, note stored', async () => {
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
    expect(balance.json.balance.confirmed_drops_total).toBe(0)
    expect(balance.json.balance.balance).toBe(813000)
  })

  it('Scenario 13 — reviewing a non-pending drop → 409', async () => {
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

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------
  it('Scenario 14 — wrong role both ways → 403', async () => {
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
  it('Scenario 15 — B3/B4: cross-org drops/balances invisible and unreachable', async () => {
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

  it('Scenario 16 — B1: injected org/agent/status/balance_before are ignored', async () => {
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
  it('Scenario 17 — commission reduces a cash balance (US-AG23)', async () => {
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

  it('Scenario 18 — a card sale earns commission but adds no cash debt (US-AG24)', async () => {
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
  it('Scenario 19 — clawback drops the commission; an absorbed loss keeps it (US-A26)', async () => {
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

  it('Scenario 20 — admin cancels with clawback via the API → commission excluded (US-A26)', async () => {
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
  it('Scenario 21 — a payout raises the balance and clears a negative position', async () => {
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

  it('Scenario 22 — payout to an unknown/cross-org agent → 404; wrong role → 403', async () => {
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
