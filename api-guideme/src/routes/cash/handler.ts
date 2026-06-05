import type { Context } from 'hono'
import { and, desc, eq, ne, or, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import { agentExpenses, cashDrops, folios, payouts, users } from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type {
  AddExpenseInput,
  CreateDropInput,
  CreatePayoutInput,
  ReviewDropInput,
} from './schema'

export type CashContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

const toSeconds = (d: Date) => Math.floor(d.getTime() / 1000)
const tsOrNull = (d: Date | null) => (d ? toSeconds(d) : null)

// --- Balance derivation -------------------------------------------------------
// The running balance is never stored — it is recomputed live from events on every read
// (mirrors deriveIncome; cannot drift). Scoped to (organization_id, agent_id), no day
// boundary:
//   balance = cash_collected − commissions − expenses − confirmed_drops + payouts
// where cash_collected sums amount_paid over non-cancelled CASH folios (card sales add no
// cash debt), commissions sums commission_amount over folios the agent still keeps (any
// non-cancelled folio, or a cancelled one the company absorbed — clawback=false), and
// payouts (company→agent) raise the balance. Only confirmed drops reduce the balance;
// pending drops are reported separately (the agent is still liable until acknowledged).

const sumCashCollected = async (db: Db, org: string, agentId: string) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${folios.amountPaid}), 0)` })
    .from(folios)
    .where(
      and(
        eq(folios.organizationId, org),
        eq(folios.agentId, agentId),
        ne(folios.status, 'cancelled'),
        eq(folios.paymentMethod, 'cash'),
      ),
    )
  return Number(row?.total ?? 0)
}

const sumCommissions = async (db: Db, org: string, agentId: string) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${folios.commissionAmount}), 0)` })
    .from(folios)
    .where(
      and(
        eq(folios.organizationId, org),
        eq(folios.agentId, agentId),
        // Kept on any live folio, or on a cancelled folio the company absorbed.
        or(ne(folios.status, 'cancelled'), eq(folios.cancellationClawback, false)),
      ),
    )
  return Number(row?.total ?? 0)
}

const sumExpenses = async (db: Db, org: string, agentId: string) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${agentExpenses.amount}), 0)` })
    .from(agentExpenses)
    .where(
      and(eq(agentExpenses.organizationId, org), eq(agentExpenses.agentId, agentId)),
    )
  return Number(row?.total ?? 0)
}

const sumPayouts = async (db: Db, org: string, agentId: string) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${payouts.amount}), 0)` })
    .from(payouts)
    .where(and(eq(payouts.organizationId, org), eq(payouts.agentId, agentId)))
  return Number(row?.total ?? 0)
}

const dropsRollup = async (
  db: Db,
  org: string,
  agentId: string,
  status: 'pending' | 'confirmed' | 'rejected',
) => {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${cashDrops.amount}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(cashDrops)
    .where(
      and(
        eq(cashDrops.organizationId, org),
        eq(cashDrops.agentId, agentId),
        eq(cashDrops.status, status),
      ),
    )
  return { total: Number(row?.total ?? 0), count: Number(row?.count ?? 0) }
}

const deriveBalance = async (db: Db, org: string, agentId: string) => {
  const cashCollected = await sumCashCollected(db, org, agentId)
  const commissionTotal = await sumCommissions(db, org, agentId)
  const expenseTotal = await sumExpenses(db, org, agentId)
  const payoutsTotal = await sumPayouts(db, org, agentId)
  const confirmed = await dropsRollup(db, org, agentId, 'confirmed')
  const pending = await dropsRollup(db, org, agentId, 'pending')
  return {
    cashCollected,
    commissionTotal,
    expenseTotal,
    payoutsTotal,
    confirmedDropsTotal: confirmed.total,
    pendingDropsTotal: pending.total,
    pendingDropsCount: pending.count,
    balance:
      cashCollected - commissionTotal - expenseTotal - confirmed.total + payoutsTotal,
  }
}

// Shape a cash-drop row for the wire. `agent` is attached only on the admin surface.
const serializeDrop = (
  d: {
    id: string
    amount: number
    balanceBefore: number
    status: 'pending' | 'confirmed' | 'rejected'
    note: string | null
    reviewedBy: string | null
    reviewedAt: Date | null
    reviewNote: string | null
    createdAt: Date
  },
  agent?: { id: string; name: string },
) => ({
  id: d.id,
  ...(agent ? { agent } : {}),
  amount: d.amount,
  balance_before: d.balanceBefore,
  status: d.status,
  note: d.note,
  reviewed_by: d.reviewedBy,
  reviewed_at: tsOrNull(d.reviewedAt),
  review_note: d.reviewNote,
  created_at: toSeconds(d.createdAt),
})

// --- Agent surface (/me/*) — scoped to (org, caller) --------------------------

// US-AG12 — the agent's live running balance + breakdown, their expenses, and recent drops
// (all statuses, newest first) for context.
export const getMyBalance = async (c: CashContext) => {
  const user = c.get('user')
  const org = user.organizationId
  const db = getDb(c.env)

  const derived = await deriveBalance(db, org, user.userId)

  const expenseRows = await db
    .select({
      id: agentExpenses.id,
      description: agentExpenses.description,
      amount: agentExpenses.amount,
      createdAt: agentExpenses.createdAt,
    })
    .from(agentExpenses)
    .where(
      and(
        eq(agentExpenses.organizationId, org),
        eq(agentExpenses.agentId, user.userId),
      ),
    )
    .orderBy(desc(agentExpenses.createdAt))

  const dropRows = await db
    .select({
      id: cashDrops.id,
      amount: cashDrops.amount,
      balanceBefore: cashDrops.balanceBefore,
      status: cashDrops.status,
      note: cashDrops.note,
      reviewedBy: cashDrops.reviewedBy,
      reviewedAt: cashDrops.reviewedAt,
      reviewNote: cashDrops.reviewNote,
      createdAt: cashDrops.createdAt,
    })
    .from(cashDrops)
    .where(
      and(eq(cashDrops.organizationId, org), eq(cashDrops.agentId, user.userId)),
    )
    .orderBy(desc(cashDrops.createdAt))

  return c.json({
    balance: {
      cash_collected: derived.cashCollected,
      commission_total: derived.commissionTotal,
      expense_total: derived.expenseTotal,
      confirmed_drops_total: derived.confirmedDropsTotal,
      pending_drops_total: derived.pendingDropsTotal,
      payouts_total: derived.payoutsTotal,
      balance: derived.balance,
      expenses: expenseRows.map((e) => ({
        id: e.id,
        description: e.description,
        amount: e.amount,
        created_at: toSeconds(e.createdAt),
      })),
      drops: dropRows.map((d) => serializeDrop(d)),
    },
  })
}

// US-AG13 — register an operating expense. org/agent come from context (never the body).
export const addExpense = async (c: CashContext) => {
  const user = c.get('user')
  const input = (await c.req.json()) as AddExpenseInput
  const db = getDb(c.env)

  const [expense] = await db
    .insert(agentExpenses)
    .values({
      id: crypto.randomUUID(),
      organizationId: user.organizationId,
      agentId: user.userId,
      description: input.description,
      amount: input.amount,
    })
    .returning()

  return c.json(
    {
      expense: {
        id: expense.id,
        description: expense.description,
        amount: expense.amount,
        created_at: toSeconds(expense.createdAt),
      },
    },
    201,
  )
}

// US-AG13 — remove one of the caller's expenses. 404 if unknown / not owned / cross-org.
export const deleteExpense = async (c: CashContext) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  const deleted = await db
    .delete(agentExpenses)
    .where(
      and(
        eq(agentExpenses.id, id),
        eq(agentExpenses.organizationId, user.organizationId),
        eq(agentExpenses.agentId, user.userId),
      ),
    )
    .returning({ id: agentExpenses.id })

  if (deleted.length === 0) {
    throw new ApiError('NOT_FOUND', 404, 'Expense not found')
  }

  return c.json({ ok: true })
}

// US-AG14 — register a cash drop (hand-in). The server snapshots balance_before from the
// live derivation and forces status='pending', agent_id=caller. balance_before in the body
// is ignored.
export const createDrop = async (c: CashContext) => {
  const user = c.get('user')
  const org = user.organizationId
  const input = (await c.req.json()) as CreateDropInput
  const db = getDb(c.env)

  const { balance } = await deriveBalance(db, org, user.userId)

  const [drop] = await db
    .insert(cashDrops)
    .values({
      id: crypto.randomUUID(),
      organizationId: org,
      agentId: user.userId,
      amount: input.amount,
      balanceBefore: balance,
      status: 'pending',
      note: input.note ?? null,
    })
    .returning()

  return c.json({ drop: serializeDrop(drop) }, 201)
}

// US-AG14 — cancel a still-pending drop. 404 unknown/not owned; 409 once confirmed/rejected.
export const cancelDrop = async (c: CashContext) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  const [drop] = await db
    .select({ id: cashDrops.id, status: cashDrops.status })
    .from(cashDrops)
    .where(
      and(
        eq(cashDrops.id, id),
        eq(cashDrops.organizationId, user.organizationId),
        eq(cashDrops.agentId, user.userId),
      ),
    )
    .limit(1)

  if (!drop) {
    throw new ApiError('NOT_FOUND', 404, 'Cash drop not found')
  }
  if (drop.status !== 'pending') {
    throw new ApiError('CONFLICT', 409, 'Only a pending cash drop can be cancelled')
  }

  await db
    .delete(cashDrops)
    .where(
      and(
        eq(cashDrops.id, id),
        eq(cashDrops.organizationId, user.organizationId),
        eq(cashDrops.agentId, user.userId),
        eq(cashDrops.status, 'pending'),
      ),
    )

  return c.json({ ok: true })
}

// --- Admin surface (org-wide, agents in the caller's org only) ----------------

// US-A19 — each agent's outstanding balance + pending rollup (the company's cash exposure).
// MVP derives per agent (N+1 acceptable at this scale; grouping is a later optimization —
// TECH_DEBT). Ordered by balance desc (largest exposure first).
export const listBalances = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)

  const agents = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, org), eq(users.role, 'agent')))

  const balances = []
  for (const agent of agents) {
    const d = await deriveBalance(db, org, agent.id)
    balances.push({
      agent: { id: agent.id, name: agent.name },
      cash_collected: d.cashCollected,
      commission_total: d.commissionTotal,
      expense_total: d.expenseTotal,
      confirmed_drops_total: d.confirmedDropsTotal,
      payouts_total: d.payoutsTotal,
      balance: d.balance,
      pending_drops_total: d.pendingDropsTotal,
      pending_drops_count: d.pendingDropsCount,
    })
  }

  balances.sort((a, b) => b.balance - a.balance)

  return c.json({ balances })
}

// US-A19 — the drops review queue, org-scoped, newest first. Defaults to status=pending;
// optional agent_id filter. Each row carries its agent (joined).
export const listDrops = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)

  const statusQ = c.req.query('status')
  const agentQ = c.req.query('agent_id')

  const filters = [eq(cashDrops.organizationId, org)]
  if (statusQ === 'pending' || statusQ === 'confirmed' || statusQ === 'rejected') {
    filters.push(eq(cashDrops.status, statusQ))
  } else if (statusQ !== 'all') {
    filters.push(eq(cashDrops.status, 'pending'))
  }
  if (agentQ) filters.push(eq(cashDrops.agentId, agentQ))

  const rows = await db
    .select({
      id: cashDrops.id,
      agentId: cashDrops.agentId,
      agentName: users.name,
      amount: cashDrops.amount,
      balanceBefore: cashDrops.balanceBefore,
      status: cashDrops.status,
      note: cashDrops.note,
      reviewedBy: cashDrops.reviewedBy,
      reviewedAt: cashDrops.reviewedAt,
      reviewNote: cashDrops.reviewNote,
      createdAt: cashDrops.createdAt,
    })
    .from(cashDrops)
    .innerJoin(users, eq(cashDrops.agentId, users.id))
    .where(and(...filters))
    .orderBy(desc(cashDrops.createdAt))

  return c.json({
    drops: rows.map((r) =>
      serializeDrop(r, { id: r.agentId, name: r.agentName }),
    ),
  })
}

// Re-read one drop (with its agent) scoped to the caller's org. null if unknown/cross-org.
const readDrop = async (db: Db, org: string, id: string) => {
  const [r] = await db
    .select({
      id: cashDrops.id,
      agentId: cashDrops.agentId,
      agentName: users.name,
      amount: cashDrops.amount,
      balanceBefore: cashDrops.balanceBefore,
      status: cashDrops.status,
      note: cashDrops.note,
      reviewedBy: cashDrops.reviewedBy,
      reviewedAt: cashDrops.reviewedAt,
      reviewNote: cashDrops.reviewNote,
      createdAt: cashDrops.createdAt,
    })
    .from(cashDrops)
    .innerJoin(users, eq(cashDrops.agentId, users.id))
    .where(and(eq(cashDrops.id, id), eq(cashDrops.organizationId, org)))
    .limit(1)

  if (!r) return null
  return serializeDrop(r, { id: r.agentId, name: r.agentName })
}

// US-A19 — one drop's detail. 404 cross-org/unknown (no existence leak).
export const getDropDetail = async (c: CashContext) => {
  const admin = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  const drop = await readDrop(db, admin.organizationId, id)
  if (!drop) {
    throw new ApiError('NOT_FOUND', 404, 'Cash drop not found')
  }

  return c.json({ drop })
}

// US-A19 — confirm receipt or reject a pending drop. 404 unknown/cross-org; 409 if the drop
// is not pending. The UPDATE is guarded status='pending' as a race backstop. reviewed_by is
// the admin from context. A confirmed drop reduces the agent's derived balance on next read.
export const reviewDrop = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id')
  const input = (await c.req.json()) as ReviewDropInput
  const db = getDb(c.env)

  const [drop] = await db
    .select({ id: cashDrops.id, status: cashDrops.status })
    .from(cashDrops)
    .where(and(eq(cashDrops.id, id), eq(cashDrops.organizationId, org)))
    .limit(1)

  if (!drop) {
    throw new ApiError('NOT_FOUND', 404, 'Cash drop not found')
  }
  if (drop.status !== 'pending') {
    throw new ApiError('CONFLICT', 409, 'This cash drop has already been reviewed')
  }

  const now = new Date()
  await db
    .update(cashDrops)
    .set({
      status: input.decision,
      reviewedBy: admin.userId,
      reviewedAt: now,
      reviewNote: input.note ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(cashDrops.id, id),
        eq(cashDrops.organizationId, org),
        eq(cashDrops.status, 'pending'),
      ),
    )

  const updated = await readDrop(db, org, id)
  return c.json({ drop: updated })
}

// US-A25 — register a company-to-agent payout (transfer/payroll) to clear a negative
// balance. Immediate (no review): it raises the agent's balance by `amount` on next read.
// `agent_id` must name an agent in the admin's org (else 404 — no cross-org leak);
// organization_id / created_by come from context, never the body.
export const registerPayout = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const input = (await c.req.json()) as CreatePayoutInput
  const db = getDb(c.env)

  const [agent] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, input.agent_id),
        eq(users.organizationId, org),
        eq(users.role, 'agent'),
      ),
    )
    .limit(1)

  if (!agent) {
    throw new ApiError('NOT_FOUND', 404, 'Agent not found')
  }

  const [payout] = await db
    .insert(payouts)
    .values({
      id: crypto.randomUUID(),
      organizationId: org,
      agentId: input.agent_id,
      amount: input.amount,
      note: input.note ?? null,
      createdBy: admin.userId,
    })
    .returning()

  return c.json(
    {
      payout: {
        id: payout.id,
        agent_id: payout.agentId,
        amount: payout.amount,
        note: payout.note,
        created_at: toSeconds(payout.createdAt),
      },
    },
    201,
  )
}
