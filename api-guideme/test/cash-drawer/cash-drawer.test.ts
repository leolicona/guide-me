import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Agent's Daily Cash Drawer with Operating Expenses — US-AG12, AG13, AG14, US-A19.
// Spec: docs/cash-drawer/cash-drawer.spec.md (Scenarios 1–18).
// Income is server-derived from folios; a submitted closure is an immutable snapshot.
// Multitenancy isolation (17–18) uses the shared `seedTwoOrgs` helper.

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const DATE = '2026-06-04'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

// --- Local seeders (raw D1) ------------------------------------------------

const folioCreatedAt = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000)

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  total: number
  amountPaid: number
  date?: string
}

const seedFolio = async ({
  organizationId,
  agentId,
  status = 'paid',
  total,
  amountPaid,
  date = DATE,
}: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = folioCreatedAt(date)
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(id, organizationId, agentId, status, total, total, amountPaid, ts, ts)
    .run()
  return id
}

const getDrawerRow = (org: string, agentId: string, date: string) =>
  env.DB.prepare(
    `SELECT id, status, total_collected, expense_total, net_balance, folio_count,
            submitted_at, reviewed_by, review_note
       FROM cash_drawers WHERE organization_id = ? AND agent_id = ? AND business_date = ?`,
  )
    .bind(org, agentId, date)
    .first<{
      id: string
      status: string
      total_collected: number | null
      expense_total: number | null
      net_balance: number | null
      folio_count: number | null
      submitted_at: number | null
      reviewed_by: string | null
      review_note: string | null
    }>()

const countDrawers = async (org: string) => {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM cash_drawers WHERE organization_id = ?`,
  )
    .bind(org)
    .first<{ c: number }>()
  return r?.c ?? 0
}

const clearCashDb = async () => {
  await env.DB.exec('DELETE FROM cash_drawer_expenses')
  await env.DB.exec('DELETE FROM cash_drawers')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearCashDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

const BASE = 'http://api.local/api/cash-drawers'

// --- API helpers -----------------------------------------------------------

const getMe = async (email: string, date = DATE) => {
  const res = await SELF.fetch(`${BASE}/me?date=${date}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const addExpense = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${BASE}/me/expenses`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ date: DATE, ...body }),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const delExpense = async (email: string, id: string) => {
  const res = await SELF.fetch(`${BASE}/me/expenses/${id}`, {
    method: 'DELETE',
    headers: auth(email),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const close = async (email: string, date = DATE) => {
  const res = await SELF.fetch(`${BASE}/me/close`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ date }),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const listDrawers = async (email: string, query = '') => {
  const res = await SELF.fetch(`${BASE}${query ? `?${query}` : ''}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const getDrawer = async (email: string, id: string) => {
  const res = await SELF.fetch(`${BASE}/${id}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const review = async (email: string, id: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${BASE}/${id}/review`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}

// Seed an admin (creates the org) + an agent in the same org.
const seedOrgWithStaff = async () => {
  const admin = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const agent = await seedUser({
    email: AGENT_EMAIL,
    role: 'agent',
    organizationId: admin.organizationId,
  })
  return { org: admin.organizationId, adminId: admin.userId, agentId: agent.userId }
}

// ---------------------------------------------------------------------------
// US-AG12 — daily summary
// ---------------------------------------------------------------------------
describe('US-AG12 — daily summary', () => {
  it('Scenario 1 — live summary aggregates folios and expenses', async () => {
    const { org, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId: org, agentId, total: 300000, amountPaid: 300000 })
    await seedFolio({ organizationId: org, agentId, total: 400000, amountPaid: 400000 })
    await seedFolio({ organizationId: org, agentId, total: 145000, amountPaid: 145000 })
    await addExpense(AGENT_EMAIL, { description: 'Gasoline', amount: 32000 })

    const { status, json } = await getMe(AGENT_EMAIL)
    expect(status).toBe(200)
    expect(json.drawer.status).toBe('open')
    expect(json.drawer.income).toMatchObject({
      folio_count: 3,
      total_collected: 845000,
      pending_balance: 0,
    })
    expect(json.drawer.expense_total).toBe(32000)
    expect(json.drawer.net_balance).toBe(813000)
  })

  it('Scenario 2 — no activity returns a virtual open drawer, no row created', async () => {
    const { org } = await seedOrgWithStaff()
    const { status, json } = await getMe(AGENT_EMAIL)
    expect(status).toBe(200)
    expect(json.drawer.id).toBeNull()
    expect(json.drawer.status).toBe('open')
    expect(json.drawer.income).toMatchObject({ folio_count: 0, total_collected: 0 })
    expect(json.drawer.expenses).toEqual([])
    expect(json.drawer.net_balance).toBe(0)
    expect(await countDrawers(org)).toBe(0)
  })

  it('Scenario 3 — cancelled folios are excluded from collected', async () => {
    const { org, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId: org, agentId, total: 200000, amountPaid: 200000 })
    await seedFolio({ organizationId: org, agentId, status: 'cancelled', total: 150000, amountPaid: 150000 })

    const { json } = await getMe(AGENT_EMAIL)
    expect(json.drawer.income.folio_count).toBe(1)
    expect(json.drawer.income.total_collected).toBe(200000)
  })
})

// ---------------------------------------------------------------------------
// US-AG13 — operating expenses
// ---------------------------------------------------------------------------
describe('US-AG13 — operating expenses', () => {
  it('Scenario 4 — registering an expense lazily creates the open drawer', async () => {
    const { org, agentId } = await seedOrgWithStaff()
    const { status } = await addExpense(AGENT_EMAIL, { description: 'Gasoline', amount: 32000 })
    expect(status).toBe(201)

    const row = await getDrawerRow(org, agentId, DATE)
    expect(row?.status).toBe('open')
    const { json } = await getMe(AGENT_EMAIL)
    expect(json.drawer.expense_total).toBe(32000)
  })

  it('Scenario 5 — invalid expense → 400', async () => {
    await seedOrgWithStaff()
    for (const body of [
      { description: 'X', amount: 0 },
      { description: 'X', amount: -5 },
      { description: 'X', amount: 10.5 },
      { description: '', amount: 1000 },
    ]) {
      const { status, json } = await addExpense(AGENT_EMAIL, body)
      expect(status, JSON.stringify(body)).toBe(400)
      expect(json.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('Scenario 6 — expense on a closed drawer → 409', async () => {
    await seedOrgWithStaff()
    await close(AGENT_EMAIL)
    const { status, json } = await addExpense(AGENT_EMAIL, { description: 'Late', amount: 1000 })
    expect(status).toBe(409)
    expect(json.error.code).toBe('CONFLICT')
  })

  it('Scenario 7 — delete an expense while open; 404 unknown; 409 after close', async () => {
    const { org, agentId } = await seedOrgWithStaff()
    const added = await addExpense(AGENT_EMAIL, { description: 'Gasoline', amount: 32000 })
    const expenseId = added.json.expense.id

    const del = await delExpense(AGENT_EMAIL, expenseId)
    expect(del.status).toBe(200)
    const after = await getMe(AGENT_EMAIL)
    expect(after.json.drawer.expense_total).toBe(0)

    const unknown = await delExpense(AGENT_EMAIL, crypto.randomUUID())
    expect(unknown.status).toBe(404)

    // After close, an existing expense can no longer be deleted.
    const e2 = await addExpense(AGENT_EMAIL, { description: 'Supplies', amount: 5000 })
    await close(AGENT_EMAIL)
    const delClosed = await delExpense(AGENT_EMAIL, e2.json.expense.id)
    expect(delClosed.status).toBe(409)
    expect(await getDrawerRow(org, agentId, DATE)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// US-AG14 — submit the closure
// ---------------------------------------------------------------------------
describe('US-AG14 — submit closure', () => {
  it('Scenario 8 — close snapshots totals and locks the day (immutable)', async () => {
    const { org, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId: org, agentId, total: 300000, amountPaid: 300000 })
    await seedFolio({ organizationId: org, agentId, total: 200000, amountPaid: 200000 })
    await addExpense(AGENT_EMAIL, { description: 'Gasoline', amount: 50000 })

    const { status, json } = await close(AGENT_EMAIL)
    expect(status).toBe(200)
    expect(json.drawer.status).toBe('submitted')
    expect(json.drawer.income.total_collected).toBe(500000)
    expect(json.drawer.income.folio_count).toBe(2)
    expect(json.drawer.expense_total).toBe(50000)
    expect(json.drawer.net_balance).toBe(450000)
    expect(json.drawer.submitted_at).toBeGreaterThan(0)

    // A folio created AFTER the close must not change the snapshot.
    await seedFolio({ organizationId: org, agentId, total: 100000, amountPaid: 100000 })
    const reread = await getMe(AGENT_EMAIL)
    expect(reread.json.drawer.income.total_collected).toBe(500000)
    expect(reread.json.drawer.income.folio_count).toBe(2)
  })

  it('Scenario 9 — closing twice → 409', async () => {
    await seedOrgWithStaff()
    await close(AGENT_EMAIL)
    const second = await close(AGENT_EMAIL)
    expect(second.status).toBe(409)
    expect(second.json.error.code).toBe('CONFLICT')
  })

  it('Scenario 10 — a zero-activity day may be closed', async () => {
    const { org, agentId } = await seedOrgWithStaff()
    const { status, json } = await close(AGENT_EMAIL)
    expect(status).toBe(200)
    expect(json.drawer.status).toBe('submitted')
    expect(json.drawer.income.total_collected).toBe(0)
    expect(json.drawer.net_balance).toBe(0)
    expect((await getDrawerRow(org, agentId, DATE))?.status).toBe('submitted')
  })
})

// ---------------------------------------------------------------------------
// US-A19 — admin review
// ---------------------------------------------------------------------------
describe('US-A19 — admin review', () => {
  const seedSubmitted = async () => {
    const ctx = await seedOrgWithStaff()
    await seedFolio({ organizationId: ctx.org, agentId: ctx.agentId, total: 300000, amountPaid: 300000 })
    await addExpense(AGENT_EMAIL, { description: 'Gasoline', amount: 50000 })
    const closed = await close(AGENT_EMAIL)
    return { ...ctx, drawerId: closed.json.drawer.id as string }
  }

  it('Scenario 11 — admin lists submitted closures in their org; open omitted', async () => {
    const { org } = await seedSubmitted()
    // A second agent with an OPEN drawer (only an expense) — must be omitted by default.
    const a2 = 'agent2@empresa.com'
    await seedUser({ email: a2, role: 'agent', organizationId: org })
    await addExpense(a2, { description: 'Misc', amount: 1000 })

    const { status, json } = await listDrawers(ADMIN_EMAIL)
    expect(status).toBe(200)
    expect(json.drawers.length).toBe(1)
    expect(json.drawers[0]).toMatchObject({ status: 'submitted', total_collected: 300000 })
    expect(json.drawers[0].agent.name).toBeTruthy()
  })

  it('Scenario 12 — admin views a closure detail', async () => {
    const { drawerId } = await seedSubmitted()
    const { status, json } = await getDrawer(ADMIN_EMAIL, drawerId)
    expect(status).toBe(200)
    expect(json.drawer.income.total_collected).toBe(300000)
    expect(json.drawer.expense_total).toBe(50000)
    expect(json.drawer.expenses.length).toBe(1)
    expect(json.drawer.agent.name).toBeTruthy()
  })

  it('Scenario 13 — admin approves a closure', async () => {
    const { org, agentId, adminId, drawerId } = await seedSubmitted()
    const { status, json } = await review(ADMIN_EMAIL, drawerId, { decision: 'approved' })
    expect(status).toBe(200)
    expect(json.drawer.status).toBe('approved')
    expect(json.drawer.reviewed_at).toBeGreaterThan(0)
    expect((await getDrawerRow(org, agentId, DATE))?.reviewed_by).toBe(adminId)
  })

  it('Scenario 14 — admin rejects with a note', async () => {
    const { org, agentId, drawerId } = await seedSubmitted()
    const { json } = await review(ADMIN_EMAIL, drawerId, {
      decision: 'rejected',
      note: 'Cash short by 200.',
    })
    expect(json.drawer.status).toBe('rejected')
    expect((await getDrawerRow(org, agentId, DATE))?.review_note).toBe('Cash short by 200.')
  })

  it('Scenario 15 — reviewing a non-submitted or already-reviewed closure → 409', async () => {
    const { org, agentId, drawerId } = await seedSubmitted()

    // Already reviewed → 409.
    await review(ADMIN_EMAIL, drawerId, { decision: 'approved' })
    const again = await review(ADMIN_EMAIL, drawerId, { decision: 'rejected' })
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('CONFLICT')

    // An OPEN drawer (an expense on another day, never submitted) → 409.
    await addExpense(AGENT_EMAIL, { description: 'Misc', amount: 1000, date: '2026-06-05' })
    const openRow = (await getDrawerRow(org, agentId, '2026-06-05'))!
    const openReview = await review(ADMIN_EMAIL, openRow.id, { decision: 'approved' })
    expect(openReview.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// Roles & multitenancy
// ---------------------------------------------------------------------------
describe('Roles & multitenancy', () => {
  it('Scenario 16 — wrong role → 403 both ways', async () => {
    await seedOrgWithStaff()
    const agentOnAdmin = await listDrawers(AGENT_EMAIL)
    expect(agentOnAdmin.status).toBe(403)
    const adminOnMe = await getMe(ADMIN_EMAIL)
    expect(adminOnMe.status).toBe(403)
  })

  it('Scenario 17 — B3/B4: cross-org drawers are invisible and unreachable', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: agentB, role: 'agent', organizationId: orgB.organizationId })

    // Each agent submits a closure in their own org.
    await close(agentA)
    const closedB = await close(agentB)
    const drawerBId = closedB.json.drawer.id as string

    // admin A only sees org A.
    const list = await listDrawers(orgA.adminEmail, 'status=submitted')
    expect(list.json.drawers.length).toBe(1)

    // admin A cannot read/review org B's drawer by id.
    const foreignGet = await getDrawer(orgA.adminEmail, drawerBId)
    expect(foreignGet.status).toBe(404)
    const foreignReview = await review(orgA.adminEmail, drawerBId, { decision: 'approved' })
    expect(foreignReview.status).toBe(404)
  })

  it('Scenario 18 — B1: injected org/agent/totals are ignored', async () => {
    const { org, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId: org, agentId, total: 500000, amountPaid: 500000 })

    // Inject foreign scoping + a forged total — all must be ignored.
    await SELF.fetch(`${BASE}/me/expenses`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({
        description: 'Gasoline',
        amount: 40000,
        date: DATE,
        organizationId: 'org_b',
        agent_id: 'someone-else',
        total_collected: 999999,
      }),
    })

    const closed = await SELF.fetch(`${BASE}/me/close`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({ date: DATE, total_collected: 999999, net_balance: 999999 }),
    })
    const body = (await closed.json()) as any
    expect(body.drawer.income.total_collected).toBe(500000) // server value, not 999999
    expect(body.drawer.expense_total).toBe(40000)
    expect(body.drawer.net_balance).toBe(460000)

    const row = await getDrawerRow(org, agentId, DATE)
    expect(row?.total_collected).toBe(500000)
  })
})
