import type { Context } from 'hono'
import { and, desc, eq, gt, lte, ne, or, sql } from 'drizzle-orm'
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
// Minor units → a plain decimal string for human-readable audit notes (not locale-aware).
const money = (minor: number) => (minor / 100).toFixed(2)

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

// Each sum accepts an optional `since` (a Date): when present, only events created strictly
// after it are counted. This lets the same helpers compute both the all-time balance and the
// shift-scoped breakdown (events since the agent's last confirmed drop).
const sumCashCollected = async (
  db: Db,
  org: string,
  agentId: string,
  since?: Date,
) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${folios.amountPaid}), 0)` })
    .from(folios)
    .where(
      and(
        eq(folios.organizationId, org),
        eq(folios.agentId, agentId),
        ne(folios.status, 'cancelled'),
        eq(folios.paymentMethod, 'cash'),
        ...(since ? [gt(folios.createdAt, since)] : []),
      ),
    )
  return Number(row?.total ?? 0)
}

const sumCommissions = async (
  db: Db,
  org: string,
  agentId: string,
  since?: Date,
) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${folios.commissionAmount}), 0)` })
    .from(folios)
    .where(
      and(
        eq(folios.organizationId, org),
        eq(folios.agentId, agentId),
        // Kept on any live folio, or on a cancelled folio the company absorbed.
        or(ne(folios.status, 'cancelled'), eq(folios.cancellationClawback, false)),
        ...(since ? [gt(folios.createdAt, since)] : []),
      ),
    )
  return Number(row?.total ?? 0)
}

const sumExpenses = async (db: Db, org: string, agentId: string, since?: Date) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${agentExpenses.amount}), 0)` })
    .from(agentExpenses)
    .where(
      and(
        eq(agentExpenses.organizationId, org),
        eq(agentExpenses.agentId, agentId),
        ...(since ? [gt(agentExpenses.createdAt, since)] : []),
      ),
    )
  return Number(row?.total ?? 0)
}

const sumPayouts = async (db: Db, org: string, agentId: string, since?: Date) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${payouts.amount}), 0)` })
    .from(payouts)
    .where(
      and(
        eq(payouts.organizationId, org),
        eq(payouts.agentId, agentId),
        ...(since ? [gt(payouts.createdAt, since)] : []),
      ),
    )
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

// Reversal of pre-watermark folios cancelled AFTER the watermark (TECH_DEBT §12a). A confirmed
// drop's `balance_after` baked these folios in while they were still live; cancelling one later
// must NOT silently rewrite that settled snapshot. Instead the cash (and any clawed-back
// commission) is reversed in the CURRENT shift, dated to the cancellation. Detected purely from
// existing columns: `created_at <= watermark AND cancelled_at > watermark`.
const sumCancellationReversal = async (
  db: Db,
  org: string,
  agentId: string,
  since: Date,
) => {
  const base = and(
    eq(folios.organizationId, org),
    eq(folios.agentId, agentId),
    eq(folios.status, 'cancelled'),
    lte(folios.createdAt, since),
    gt(folios.cancelledAt, since),
  )
  // Cash that balance_after counted as collected but is now cancelled (cash folios only).
  const [cashRow] = await db
    .select({ total: sql<number>`coalesce(sum(${folios.amountPaid}), 0)` })
    .from(folios)
    .where(and(base, eq(folios.paymentMethod, 'cash')))
  // Commission that balance_after subtracted but is now clawed back (any payment method).
  const [commissionRow] = await db
    .select({ total: sql<number>`coalesce(sum(${folios.commissionAmount}), 0)` })
    .from(folios)
    .where(and(base, eq(folios.cancellationClawback, true)))
  return {
    cash: Number(cashRow?.total ?? 0),
    commission: Number(commissionRow?.total ?? 0),
  }
}

// The settlement watermark: the instant of the agent's most recent confirmed drop. Events at or
// before it are SETTLED (folded into that drop's balance_after) and must not be mutated
// (TECH_DEBT §12a). null when the agent has no confirmed drop yet.
const settlementWatermark = async (
  db: Db,
  org: string,
  agentId: string,
): Promise<Date | null> => {
  const [anchor] = await db
    .select({ reviewedAt: cashDrops.reviewedAt, createdAt: cashDrops.createdAt })
    .from(cashDrops)
    .where(
      and(
        eq(cashDrops.organizationId, org),
        eq(cashDrops.agentId, agentId),
        eq(cashDrops.status, 'confirmed'),
      ),
    )
    .orderBy(desc(cashDrops.reviewedAt), desc(cashDrops.createdAt))
    .limit(1)
  if (!anchor) return null
  return anchor.reviewedAt ?? anchor.createdAt
}

// US-AG12 — the agent's running balance AND its shift-scoped breakdown, in one pass.
//
// `balance` is the authoritative all-time figure (the physical cash held). The breakdown
// (carry_forward + collected − commissions − expenses + payouts) re-expresses it as the
// agent's CURRENT SHIFT — events since the anchor (their most recent confirmed drop). The
// anchor is taken on the SETTLEMENT timeline (reviewed_at, tiebreak created_at) so that
// out-of-order confirmation resolves to the drop confirmed last (TECH_DEBT §12e).
//
// FAST PATH (TECH_DEBT §12b/e): when the anchor carries a `balance_after` watermark (set at
// confirm time), the balance is `balance_after + Σ(events since reviewed_at)` — bounded by
// SHIFT size, not full history — and `carry_forward` IS `balance_after`, read directly (no
// balancing term). FALLBACK (a legacy confirmed drop with no watermark, or no confirmed drop
// at all): the full-history derivation, with `carry_forward` reconstructed as the reconciling
// balancing term — byte-for-byte the behaviour from before the watermark shipped.
const deriveBalance = async (db: Db, org: string, agentId: string) => {
  const pending = await dropsRollup(db, org, agentId, 'pending')

  const [anchor] = await db
    .select({
      id: cashDrops.id,
      amount: cashDrops.amount,
      balanceBefore: cashDrops.balanceBefore,
      balanceAfter: cashDrops.balanceAfter,
      reviewedAt: cashDrops.reviewedAt,
      createdAt: cashDrops.createdAt,
    })
    .from(cashDrops)
    .where(
      and(
        eq(cashDrops.organizationId, org),
        eq(cashDrops.agentId, agentId),
        eq(cashDrops.status, 'confirmed'),
      ),
    )
    .orderBy(desc(cashDrops.reviewedAt), desc(cashDrops.createdAt))
    .limit(1)

  const lastDrop = anchor
    ? {
        id: anchor.id,
        amount: anchor.amount,
        balance_before: anchor.balanceBefore,
        confirmed_at: tsOrNull(anchor.reviewedAt),
        created_at: toSeconds(anchor.createdAt),
      }
    : null

  // FAST PATH — the anchor carries a settlement watermark; sum only the current shift.
  if (anchor && anchor.balanceAfter != null && anchor.reviewedAt != null) {
    const since = anchor.reviewedAt
    const cashSince = await sumCashCollected(db, org, agentId, since)
    const commissionSince = await sumCommissions(db, org, agentId, since)
    const expenseTotal = await sumExpenses(db, org, agentId, since)
    const payoutsTotal = await sumPayouts(db, org, agentId, since)
    // A settled folio cancelled this shift reverses its collected cash (and any clawed-back
    // commission) into the current shift — keeping the watermark frozen (TECH_DEBT §12a).
    const reversal = await sumCancellationReversal(db, org, agentId, since)
    const cashCollected = cashSince - reversal.cash
    const commissionTotal = commissionSince - reversal.commission
    const carryForward = anchor.balanceAfter
    return {
      balance:
        carryForward + cashCollected - commissionTotal - expenseTotal + payoutsTotal,
      carryForward,
      cashCollected,
      commissionTotal,
      expenseTotal,
      payoutsTotal,
      since,
      lastDrop,
      pendingDropsTotal: pending.total,
      pendingDropsCount: pending.count,
    }
  }

  // FALLBACK — full-history derivation; carry_forward is the reconciling balancing term.
  const allCash = await sumCashCollected(db, org, agentId)
  const allCommission = await sumCommissions(db, org, agentId)
  const allExpense = await sumExpenses(db, org, agentId)
  const allPayouts = await sumPayouts(db, org, agentId)
  const confirmed = await dropsRollup(db, org, agentId, 'confirmed')
  const balance = allCash - allCommission - allExpense - confirmed.total + allPayouts

  const since = anchor?.createdAt ?? undefined
  const cashCollected = await sumCashCollected(db, org, agentId, since)
  const commissionTotal = await sumCommissions(db, org, agentId, since)
  const expenseTotal = await sumExpenses(db, org, agentId, since)
  const payoutsTotal = await sumPayouts(db, org, agentId, since)
  const carryForward =
    balance - (cashCollected - commissionTotal - expenseTotal + payoutsTotal)

  return {
    balance,
    carryForward,
    cashCollected,
    commissionTotal,
    expenseTotal,
    payoutsTotal,
    since,
    lastDrop,
    pendingDropsTotal: pending.total,
    pendingDropsCount: pending.count,
  }
}

// Shape a cash-drop row for the wire. `agent` is attached only on the admin surface.
const serializeDrop = (
  d: {
    id: string
    amount: number
    amountRequested: number | null
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
  // The agent's original ask when an admin confirmed with a corrected amount; null otherwise.
  amount_requested: d.amountRequested,
  balance_before: d.balanceBefore,
  status: d.status,
  note: d.note,
  reviewed_by: d.reviewedBy,
  reviewed_at: tsOrNull(d.reviewedAt),
  review_note: d.reviewNote,
  created_at: toSeconds(d.createdAt),
})

// --- Agent surface (/me/*) — scoped to (org, caller) --------------------------

// US-AG12 — the agent's running balance presented as their CURRENT SHIFT: the headline
// `balance` is the full perpetual figure (physical cash held), but the breakdown
// (carry_forward + cash_collected − commission_total − expense_total) counts only events
// since the last confirmed drop. `expenses` lists the current-shift expenses; `drops` lists
// recent drops (all statuses, newest first) for context.
export const getMyBalance = async (c: CashContext) => {
  const user = c.get('user')
  const org = user.organizationId
  const db = getDb(c.env)

  const derived = await deriveBalance(db, org, user.userId)

  const expenseFilters = [
    eq(agentExpenses.organizationId, org),
    eq(agentExpenses.agentId, user.userId),
    ...(derived.since ? [gt(agentExpenses.createdAt, derived.since)] : []),
  ]
  const expenseRows = await db
    .select({
      id: agentExpenses.id,
      description: agentExpenses.description,
      amount: agentExpenses.amount,
      createdAt: agentExpenses.createdAt,
    })
    .from(agentExpenses)
    .where(and(...expenseFilters))
    .orderBy(desc(agentExpenses.createdAt))

  const dropRows = await db
    .select({
      id: cashDrops.id,
      amount: cashDrops.amount,
      amountRequested: cashDrops.amountRequested,
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
      carry_forward: derived.carryForward,
      cash_collected: derived.cashCollected,
      commission_total: derived.commissionTotal,
      expense_total: derived.expenseTotal,
      payouts_total: derived.payoutsTotal,
      pending_drops_total: derived.pendingDropsTotal,
      balance: derived.balance,
      last_drop: derived.lastDrop,
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

// US-AG13 — remove one of the caller's expenses. 404 if unknown / not owned / cross-org; 409 if
// the expense is already SETTLED behind a confirmed cash drop (TECH_DEBT §12a — settled history
// is frozen; deleting it would silently move a number the admin already settled against).
export const deleteExpense = async (c: CashContext) => {
  const user = c.get('user')
  const org = user.organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)

  const [expense] = await db
    .select({ id: agentExpenses.id, createdAt: agentExpenses.createdAt })
    .from(agentExpenses)
    .where(
      and(
        eq(agentExpenses.id, id),
        eq(agentExpenses.organizationId, org),
        eq(agentExpenses.agentId, user.userId),
      ),
    )
    .limit(1)

  if (!expense) {
    throw new ApiError('NOT_FOUND', 404, 'Expense not found')
  }

  const watermark = await settlementWatermark(db, org, user.userId)
  if (watermark && expense.createdAt <= watermark) {
    throw new ApiError(
      'CONFLICT',
      409,
      'This expense was already settled in a confirmed cash drop and can no longer be removed',
    )
  }

  await db
    .delete(agentExpenses)
    .where(
      and(
        eq(agentExpenses.id, id),
        eq(agentExpenses.organizationId, org),
        eq(agentExpenses.agentId, user.userId),
      ),
    )

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
// Derived org-wide with a fixed set of `GROUP BY agent_id` aggregates (O(1) queries, not the
// per-agent loop), then merged in memory. Uses the SAME predicates as `deriveBalance`, so the
// result is identical to the old loop. The /balances view stays ALL-TIME (no watermark) —
// company exposure, not the agent's shift. Ordered by balance desc (largest exposure first).
export const listBalances = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)

  // A balance row is emitted for every org agent, even one with no activity (→ all zeros).
  const agents = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, org), eq(users.role, 'agent')))

  // cash_collected — non-cancelled CASH folios (card sales add no cash debt).
  const cashRows = await db
    .select({
      agentId: folios.agentId,
      total: sql<number>`coalesce(sum(${folios.amountPaid}), 0)`,
    })
    .from(folios)
    .where(
      and(
        eq(folios.organizationId, org),
        ne(folios.status, 'cancelled'),
        eq(folios.paymentMethod, 'cash'),
      ),
    )
    .groupBy(folios.agentId)

  // commissions — kept on any live folio, or a cancelled one the company absorbed.
  const commissionRows = await db
    .select({
      agentId: folios.agentId,
      total: sql<number>`coalesce(sum(${folios.commissionAmount}), 0)`,
    })
    .from(folios)
    .where(
      and(
        eq(folios.organizationId, org),
        or(ne(folios.status, 'cancelled'), eq(folios.cancellationClawback, false)),
      ),
    )
    .groupBy(folios.agentId)

  const expenseRows = await db
    .select({
      agentId: agentExpenses.agentId,
      total: sql<number>`coalesce(sum(${agentExpenses.amount}), 0)`,
    })
    .from(agentExpenses)
    .where(eq(agentExpenses.organizationId, org))
    .groupBy(agentExpenses.agentId)

  const payoutRows = await db
    .select({
      agentId: payouts.agentId,
      total: sql<number>`coalesce(sum(${payouts.amount}), 0)`,
    })
    .from(payouts)
    .where(eq(payouts.organizationId, org))
    .groupBy(payouts.agentId)

  // Drops grouped by (agent, status): confirmed reduces the balance; pending is the rollup.
  const dropRows = await db
    .select({
      agentId: cashDrops.agentId,
      status: cashDrops.status,
      total: sql<number>`coalesce(sum(${cashDrops.amount}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(cashDrops)
    .where(eq(cashDrops.organizationId, org))
    .groupBy(cashDrops.agentId, cashDrops.status)

  const toMap = (rows: { agentId: string; total: number }[]) =>
    new Map(rows.map((r) => [r.agentId, Number(r.total)]))
  const cashMap = toMap(cashRows)
  const commissionMap = toMap(commissionRows)
  const expenseMap = toMap(expenseRows)
  const payoutMap = toMap(payoutRows)

  const confirmedMap = new Map<string, number>()
  const pendingMap = new Map<string, { total: number; count: number }>()
  for (const r of dropRows) {
    if (r.status === 'confirmed') confirmedMap.set(r.agentId, Number(r.total))
    else if (r.status === 'pending')
      pendingMap.set(r.agentId, { total: Number(r.total), count: Number(r.count) })
  }

  const balances = agents.map((agent) => {
    const cashCollected = cashMap.get(agent.id) ?? 0
    const commissionTotal = commissionMap.get(agent.id) ?? 0
    const expenseTotal = expenseMap.get(agent.id) ?? 0
    const payoutsTotal = payoutMap.get(agent.id) ?? 0
    const confirmedDropsTotal = confirmedMap.get(agent.id) ?? 0
    const pending = pendingMap.get(agent.id) ?? { total: 0, count: 0 }
    return {
      agent: { id: agent.id, name: agent.name },
      cash_collected: cashCollected,
      commission_total: commissionTotal,
      expense_total: expenseTotal,
      confirmed_drops_total: confirmedDropsTotal,
      payouts_total: payoutsTotal,
      balance:
        cashCollected - commissionTotal - expenseTotal - confirmedDropsTotal + payoutsTotal,
      pending_drops_total: pending.total,
      pending_drops_count: pending.count,
    }
  })

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
      amountRequested: cashDrops.amountRequested,
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
      amountRequested: cashDrops.amountRequested,
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
    .select({
      id: cashDrops.id,
      agentId: cashDrops.agentId,
      status: cashDrops.status,
      amount: cashDrops.amount,
    })
    .from(cashDrops)
    .where(and(eq(cashDrops.id, id), eq(cashDrops.organizationId, org)))
    .limit(1)

  if (!drop) {
    throw new ApiError('NOT_FOUND', 404, 'Cash drop not found')
  }
  if (drop.status !== 'pending') {
    throw new ApiError('CONFLICT', 409, 'This cash drop has already been reviewed')
  }

  // Adjust-on-confirm: when the admin confirms with a corrected `amount`, stash the agent's
  // original ask into `amount_requested`, write the adjusted value into `amount`, and append
  // the delta to the review note for audit. Reject never touches the amount.
  let amount = drop.amount
  let amountRequested: number | null = null
  let reviewNote = input.note ?? null
  if (
    input.decision === 'confirmed' &&
    input.amount != null &&
    input.amount !== drop.amount
  ) {
    amountRequested = drop.amount
    amount = input.amount
    const delta = `Adjusted from ${money(drop.amount)} to ${money(input.amount)}`
    reviewNote = reviewNote ? `${reviewNote} — ${delta}` : delta
  }

  // Settlement watermark (TECH_DEBT §12b): on confirm, snapshot the agent's balance AFTER this
  // drop. The pre-confirm balance excludes this still-pending drop, so balance_after = that −
  // the (possibly adjusted) amount. `deriveBalance` is itself bounded by the prior watermark,
  // so confirming stays O(shift), not O(history). Reject leaves balance_after null.
  let balanceAfter: number | null = null
  if (input.decision === 'confirmed') {
    const pre = await deriveBalance(db, org, drop.agentId)
    balanceAfter = pre.balance - amount
  }

  const now = new Date()
  await db
    .update(cashDrops)
    .set({
      status: input.decision,
      amount,
      amountRequested,
      balanceAfter,
      reviewedBy: admin.userId,
      reviewedAt: now,
      reviewNote,
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
