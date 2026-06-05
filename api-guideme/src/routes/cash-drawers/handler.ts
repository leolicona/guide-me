import type { Context } from 'hono'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import { cashDrawers, cashDrawerExpenses, folios, users } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type {
  AddExpenseInput,
  CloseDrawerInput,
  ReviewDrawerInput,
} from './schema'

export type CashDrawerContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

type DrawerStatus = 'open' | 'submitted' | 'approved' | 'rejected'
const DRAWER_STATUSES: readonly DrawerStatus[] = [
  'open',
  'submitted',
  'approved',
  'rejected',
]

// MVP single-timezone (mirrors schedules/POS/QR): the org-local day is the server's UTC
// date unless the client pins an explicit `date`.
const utcToday = () => new Date().toISOString().slice(0, 10)

const tsOrNull = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null)

// --- Income derivation (server source of truth) ---------------------------

interface Income {
  folio_count: number
  total_collected: number
  pending_balance: number
}

// Σ over the agent's NON-cancelled folios whose created_at UTC date == businessDate.
// `created_at` is stored as unix seconds, so strftime(..., 'unixepoch') yields the day.
const deriveIncome = async (
  db: Db,
  org: string,
  agentId: string,
  businessDate: string,
): Promise<Income> => {
  const rows = await db
    .select({
      folioCount: sql<number>`count(*)`,
      totalCollected: sql<number>`coalesce(sum(${folios.amountPaid}), 0)`,
      pendingBalance: sql<number>`coalesce(sum(${folios.total} - ${folios.amountPaid}), 0)`,
    })
    .from(folios)
    .where(
      and(
        eq(folios.organizationId, org),
        eq(folios.agentId, agentId),
        ne(folios.status, 'cancelled'),
        sql`strftime('%Y-%m-%d', ${folios.createdAt}, 'unixepoch') = ${businessDate}`,
      ),
    )
  const r = rows[0]
  return {
    folio_count: Number(r?.folioCount ?? 0),
    total_collected: Number(r?.totalCollected ?? 0),
    pending_balance: Number(r?.pendingBalance ?? 0),
  }
}

const sumExpenses = async (db: Db, org: string, drawerId: string): Promise<number> => {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${cashDrawerExpenses.amount}), 0)` })
    .from(cashDrawerExpenses)
    .where(
      and(
        eq(cashDrawerExpenses.organizationId, org),
        eq(cashDrawerExpenses.cashDrawerId, drawerId),
      ),
    )
  return Number(rows[0]?.total ?? 0)
}

const listExpenses = async (db: Db, org: string, drawerId: string) => {
  const rows = await db
    .select({
      id: cashDrawerExpenses.id,
      description: cashDrawerExpenses.description,
      amount: cashDrawerExpenses.amount,
      createdAt: cashDrawerExpenses.createdAt,
    })
    .from(cashDrawerExpenses)
    .where(
      and(
        eq(cashDrawerExpenses.organizationId, org),
        eq(cashDrawerExpenses.cashDrawerId, drawerId),
      ),
    )
    .orderBy(asc(cashDrawerExpenses.createdAt))
  return rows.map((e) => ({
    id: e.id,
    description: e.description,
    amount: e.amount,
    created_at: Math.floor(e.createdAt.getTime() / 1000),
  }))
}

type DrawerRow = typeof cashDrawers.$inferSelect
type ExpenseOut = Awaited<ReturnType<typeof listExpenses>>

const snapshotIncome = (d: DrawerRow): Income => ({
  folio_count: d.folioCount ?? 0,
  total_collected: d.totalCollected ?? 0,
  pending_balance: d.pendingBalance ?? 0,
})

// Shared response shape. `agent` is attached only on the admin surface.
const serializeDrawer = (
  d: DrawerRow,
  income: Income,
  expenseTotal: number,
  netBalance: number,
  expenses: ExpenseOut,
  agent?: { id: string; name: string },
) => ({
  id: d.id,
  ...(agent ? { agent } : {}),
  business_date: d.businessDate,
  status: d.status,
  income,
  expense_total: expenseTotal,
  net_balance: netBalance,
  expenses,
  submitted_at: tsOrNull(d.submittedAt),
  reviewed_at: tsOrNull(d.reviewedAt),
  review_note: d.reviewNote,
})

// Lazily get (or create) the agent's open drawer for a day. The unique
// (org, agent, business_date) index makes the insert idempotent under races.
const getOrCreateOpenDrawer = async (
  db: Db,
  org: string,
  agentId: string,
  businessDate: string,
): Promise<DrawerRow> => {
  await db
    .insert(cashDrawers)
    .values({
      id: crypto.randomUUID(),
      organizationId: org,
      agentId,
      businessDate,
      status: 'open',
    })
    .onConflictDoNothing()

  const rows = await db
    .select()
    .from(cashDrawers)
    .where(
      and(
        eq(cashDrawers.organizationId, org),
        eq(cashDrawers.agentId, agentId),
        eq(cashDrawers.businessDate, businessDate),
      ),
    )
    .limit(1)
  return rows[0]
}

const loadDrawer = async (db: Db, org: string, agentId: string, businessDate: string) => {
  const rows = await db
    .select()
    .from(cashDrawers)
    .where(
      and(
        eq(cashDrawers.organizationId, org),
        eq(cashDrawers.agentId, agentId),
        eq(cashDrawers.businessDate, businessDate),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

// --- Agent surface (US-AG12 / AG13 / AG14) --------------------------------

// US-AG12 — the caller agent's drawer + live (or snapshot) summary for a day.
export const getMyDrawer = async (c: CashDrawerContext) => {
  const agent = c.get('user')
  const org = agent.organizationId
  const date = c.req.query('date') ?? utcToday()
  const db = getDb(c.env)

  const drawer = await loadDrawer(db, org, agent.userId, date)

  // No row yet → a virtual open drawer (reads never write).
  if (!drawer) {
    const income = await deriveIncome(db, org, agent.userId, date)
    return c.json({
      drawer: {
        id: null,
        business_date: date,
        status: 'open' as const,
        income,
        expense_total: 0,
        net_balance: income.total_collected,
        expenses: [],
        submitted_at: null,
        reviewed_at: null,
        review_note: null,
      },
    })
  }

  const expenses = await listExpenses(db, org, drawer.id)

  if (drawer.status === 'open') {
    const income = await deriveIncome(db, org, agent.userId, date)
    const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0)
    return c.json({
      drawer: serializeDrawer(
        drawer,
        income,
        expenseTotal,
        income.total_collected - expenseTotal,
        expenses,
      ),
    })
  }

  // submitted/approved/rejected → the frozen snapshot.
  return c.json({
    drawer: serializeDrawer(
      drawer,
      snapshotIncome(drawer),
      drawer.expenseTotal ?? 0,
      drawer.netBalance ?? 0,
      expenses,
    ),
  })
}

// US-AG13 — register an operating expense (lazily opens the day's drawer).
export const addExpense = async (c: CashDrawerContext) => {
  const agent = c.get('user')
  const org = agent.organizationId
  const input = (await c.req.json()) as AddExpenseInput
  const date = input.date ?? utcToday()
  const db = getDb(c.env)

  const drawer = await getOrCreateOpenDrawer(db, org, agent.userId, date)
  if (drawer.status !== 'open') {
    throw new ApiError('CONFLICT', 409, 'The drawer for this day is already closed')
  }

  const [row] = await db
    .insert(cashDrawerExpenses)
    .values({
      id: crypto.randomUUID(),
      organizationId: org,
      cashDrawerId: drawer.id,
      description: input.description,
      amount: input.amount,
    })
    .returning()

  return c.json(
    {
      expense: {
        id: row.id,
        description: row.description,
        amount: row.amount,
        created_at: Math.floor(row.createdAt.getTime() / 1000),
      },
    },
    201,
  )
}

// US-AG13 — remove an expense while the drawer is still open.
export const deleteExpense = async (c: CashDrawerContext) => {
  const agent = c.get('user')
  const org = agent.organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)

  const rows = await db
    .select({ drawerStatus: cashDrawers.status })
    .from(cashDrawerExpenses)
    .innerJoin(cashDrawers, eq(cashDrawerExpenses.cashDrawerId, cashDrawers.id))
    .where(
      and(
        eq(cashDrawerExpenses.id, id),
        eq(cashDrawerExpenses.organizationId, org),
        eq(cashDrawers.agentId, agent.userId),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) {
    throw new ApiError('NOT_FOUND', 404, 'Expense not found')
  }
  if (row.drawerStatus !== 'open') {
    throw new ApiError('CONFLICT', 409, 'The drawer for this day is already closed')
  }

  await db
    .delete(cashDrawerExpenses)
    .where(
      and(eq(cashDrawerExpenses.id, id), eq(cashDrawerExpenses.organizationId, org)),
    )

  return c.json({ ok: true })
}

// US-AG14 — submit the closure: snapshot the day's totals and lock it.
export const closeDrawer = async (c: CashDrawerContext) => {
  const agent = c.get('user')
  const org = agent.organizationId
  const input = (await c.req.json()) as CloseDrawerInput
  const date = input.date ?? utcToday()
  const db = getDb(c.env)

  const drawer = await getOrCreateOpenDrawer(db, org, agent.userId, date)
  if (drawer.status !== 'open') {
    throw new ApiError('CONFLICT', 409, 'This drawer has already been submitted')
  }

  const income = await deriveIncome(db, org, agent.userId, date)
  const expenseTotal = await sumExpenses(db, org, drawer.id)
  const netBalance = income.total_collected - expenseTotal

  await db
    .update(cashDrawers)
    .set({
      status: 'submitted',
      totalCollected: income.total_collected,
      pendingBalance: income.pending_balance,
      expenseTotal,
      netBalance,
      folioCount: income.folio_count,
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(cashDrawers.id, drawer.id),
        eq(cashDrawers.organizationId, org),
        eq(cashDrawers.status, 'open'),
      ),
    )

  const expenses = await listExpenses(db, org, drawer.id)
  const [updated] = await db
    .select()
    .from(cashDrawers)
    .where(and(eq(cashDrawers.id, drawer.id), eq(cashDrawers.organizationId, org)))
    .limit(1)

  return c.json({
    drawer: serializeDrawer(
      updated,
      snapshotIncome(updated),
      updated.expenseTotal ?? 0,
      updated.netBalance ?? 0,
      expenses,
    ),
  })
}

// --- Admin surface (US-A19) ------------------------------------------------

// US-A19 — list closures in the caller's org for review (open omitted by default).
export const listDrawers = async (c: CashDrawerContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)

  const statusQ = c.req.query('status')
  const dateQ = c.req.query('date')
  const agentQ = c.req.query('agent_id')

  const filters = [eq(cashDrawers.organizationId, org)]
  if (statusQ && (DRAWER_STATUSES as readonly string[]).includes(statusQ)) {
    filters.push(eq(cashDrawers.status, statusQ as DrawerStatus))
  } else {
    filters.push(ne(cashDrawers.status, 'open')) // nothing to review until submitted
  }
  if (dateQ) filters.push(eq(cashDrawers.businessDate, dateQ))
  if (agentQ) filters.push(eq(cashDrawers.agentId, agentQ))

  const rows = await db
    .select({
      id: cashDrawers.id,
      agentId: cashDrawers.agentId,
      agentName: users.name,
      businessDate: cashDrawers.businessDate,
      status: cashDrawers.status,
      totalCollected: cashDrawers.totalCollected,
      expenseTotal: cashDrawers.expenseTotal,
      netBalance: cashDrawers.netBalance,
      folioCount: cashDrawers.folioCount,
      submittedAt: cashDrawers.submittedAt,
      reviewedAt: cashDrawers.reviewedAt,
    })
    .from(cashDrawers)
    .innerJoin(users, eq(cashDrawers.agentId, users.id))
    .where(and(...filters))
    .orderBy(desc(cashDrawers.submittedAt), desc(cashDrawers.createdAt))

  return c.json({
    drawers: rows.map((r) => ({
      id: r.id,
      agent: { id: r.agentId, name: r.agentName },
      business_date: r.businessDate,
      status: r.status,
      total_collected: r.totalCollected ?? 0,
      expense_total: r.expenseTotal ?? 0,
      net_balance: r.netBalance ?? 0,
      folio_count: r.folioCount ?? 0,
      submitted_at: tsOrNull(r.submittedAt),
      reviewed_at: tsOrNull(r.reviewedAt),
    })),
  })
}

// Load a drawer in the caller's org joined to its agent, or 404.
const loadDrawerForAdmin = async (db: Db, org: string, id: string) => {
  const rows = await db
    .select({ drawer: cashDrawers, agentName: users.name })
    .from(cashDrawers)
    .innerJoin(users, eq(cashDrawers.agentId, users.id))
    .where(and(eq(cashDrawers.id, id), eq(cashDrawers.organizationId, org)))
    .limit(1)
  return rows[0] ?? null
}

// US-A19 — one closure's detail (snapshot + expenses + agent).
export const getDrawerDetail = async (c: CashDrawerContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)

  const found = await loadDrawerForAdmin(db, org, id)
  if (!found) {
    throw new ApiError('NOT_FOUND', 404, 'Cash drawer not found')
  }
  const d = found.drawer
  const expenses = await listExpenses(db, org, d.id)
  const agent = { id: d.agentId, name: found.agentName }

  if (d.status === 'open') {
    const income = await deriveIncome(db, org, d.agentId, d.businessDate)
    const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0)
    return c.json({
      drawer: serializeDrawer(
        d,
        income,
        expenseTotal,
        income.total_collected - expenseTotal,
        expenses,
        agent,
      ),
    })
  }

  return c.json({
    drawer: serializeDrawer(
      d,
      snapshotIncome(d),
      d.expenseTotal ?? 0,
      d.netBalance ?? 0,
      expenses,
      agent,
    ),
  })
}

// US-A19 — approve or reject a submitted closure.
export const reviewDrawer = async (c: CashDrawerContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id')
  const input = (await c.req.json()) as ReviewDrawerInput
  const db = getDb(c.env)

  const found = await loadDrawerForAdmin(db, org, id)
  if (!found) {
    throw new ApiError('NOT_FOUND', 404, 'Cash drawer not found')
  }
  if (found.drawer.status !== 'submitted') {
    throw new ApiError('CONFLICT', 409, 'Only a submitted closure can be reviewed')
  }

  await db
    .update(cashDrawers)
    .set({
      status: input.decision,
      reviewedBy: admin.userId,
      reviewedAt: new Date(),
      reviewNote: input.note ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(cashDrawers.id, id),
        eq(cashDrawers.organizationId, org),
        eq(cashDrawers.status, 'submitted'),
      ),
    )

  const updated = await loadDrawerForAdmin(db, org, id)
  const d = updated!.drawer
  const expenses = await listExpenses(db, org, id)
  return c.json({
    drawer: serializeDrawer(
      d,
      snapshotIncome(d),
      d.expenseTotal ?? 0,
      d.netBalance ?? 0,
      expenses,
      { id: d.agentId, name: updated!.agentName },
    ),
  })
}
