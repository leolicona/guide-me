import type { Context } from 'hono'
import { and, desc, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  affiliateCompanies,
  agentExpenses,
  cashDrops,
  folioPayments,
  folios,
  organizations,
  payouts,
  users,
} from '../../db/schema'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type {
  AddExpenseInput,
  CreateDropInput,
  CreatePayoutInput,
  DisputeInput,
  RegisterCollectionInput,
  ResolveDisputeInput,
  ReviewDropInput,
} from './schema'

export type CashContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

const toSeconds = (d: Date) => Math.floor(d.getTime() / 1000)
const tsOrNull = (d: Date | null) => (d ? toSeconds(d) : null)
const nowSeconds = () => Math.floor(Date.now() / 1000)
// Minor units → a plain decimal string for human-readable audit notes (not locale-aware).
const money = (minor: number) => (minor / 100).toFixed(2)

type AckState =
  | 'not_required'
  | 'pending'
  | 'signed'
  | 'auto_signed'
  | 'disputed'
  | 'resolved'

// The org's acknowledgment window in seconds (US-AG27/AG28 — configurable per org; default 24h).
const ackWindowSeconds = async (db: Db, org: string) => {
  const [row] = await db
    .select({ hours: organizations.ackWindowHours })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)
  return Number(row?.hours ?? 24) * 3600
}

// How much history each read ships (caja-surface-parity D12′). The balance payload used to carry
// the agent's ENTIRE hand-in history — no LIMIT, no `since`, while the `expenses` read beside it is
// shift-scoped — at a measured 386 bytes per row, re-fetched on every mount and window focus. The
// admin's list matches the seller folio list's 500.
//
// Both fetch ONE extra row and slice it off: that is how the response can say it capped, and a
// silent truncation reads as "everything is here" when it is not.
const MY_DROPS_PAGE = 50
const TEAM_DROPS_PAGE = 500

// Effective acknowledgment view (US-AG27/AG28, D2). A `pending` obligation whose window has
// elapsed (`now ≥ reviewed_at + window`) is PRESENTED as `auto_signed`, computed
// deterministically from timestamps — so reads are consistent even before the opportunistic
// sweep persists it. Every other state is returned as stored. Financially inert.
const ackView = (
  d: { acknowledgment: AckState; acknowledgedAt: Date | null; reviewedAt: Date | null },
  windowSeconds: number,
  now: number,
): { acknowledgment: AckState; acknowledged_at: number | null; ack_due_at: number | null } => {
  if (d.acknowledgment === 'pending' && d.reviewedAt) {
    const dueAt = toSeconds(d.reviewedAt) + windowSeconds
    if (now >= dueAt) {
      return { acknowledgment: 'auto_signed', acknowledged_at: dueAt, ack_due_at: null }
    }
    return { acknowledgment: 'pending', acknowledged_at: null, ack_due_at: dueAt }
  }
  return {
    acknowledgment: d.acknowledgment,
    acknowledged_at: tsOrNull(d.acknowledgedAt),
    ack_due_at: null,
  }
}

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

// US-AG29 — payment-method buckets (agent-balance-ux-overhaul.spec.md). Everything
// ≠ 'cash' is ELECTRONIC; the bucket is derived, never stored. This is a display-only
// read model: the shift derivation builds cash_collected / commission_total FROM these
// buckets, so `sales.cash == cash_collected` and the commission buckets sum to
// `commission_total` by construction.
type PaymentMethodKey = 'cash' | 'card' | 'transfer' | 'link'
const ELECTRONIC_METHODS = ['card', 'transfer', 'link'] as const

const zeroByMethod = (): Record<PaymentMethodKey, number> => ({
  cash: 0,
  card: 0,
  transfer: 0,
  link: 0,
})

// US-LG04 — sales per method from the LEDGER: Σ signed money rows (payment + refund) grouped by
// their OWN method, so a mixed folio's cash and transfer land in the right buckets and a cancelled
// folio's reversal (a negative refund row dated cancelled_at) nets it back out. `count` is the
// signed movement count (payment +1, refund −1) so a cancelled sale drops to zero, matching the old
// non-cancelled folio count. Keyed on collected_by (== the folio's agent for every row we write).
const sumSalesByMethod = async (db: Db, org: string, agentId: string, since?: Date) => {
  const rows = await db
    .select({
      method: folioPayments.method,
      total: sql<number>`coalesce(sum(${folioPayments.amount}), 0)`,
      count: sql<number>`coalesce(sum(case when ${folioPayments.entryType} = 'payment' then 1 when ${folioPayments.entryType} = 'refund' then -1 else 0 end), 0)`,
    })
    .from(folioPayments)
    .where(
      and(
        eq(folioPayments.organizationId, org),
        eq(folioPayments.collectedBy, agentId),
        inArray(folioPayments.entryType, ['payment', 'refund']),
        ...(since ? [gt(folioPayments.createdAt, since)] : []),
      ),
    )
    .groupBy(folioPayments.method)
  const totals = zeroByMethod()
  const counts = zeroByMethod()
  for (const r of rows) {
    if (!r.method) continue
    totals[r.method] = Number(r.total ?? 0)
    counts[r.method] = Number(r.count ?? 0)
  }
  return { totals, counts }
}

// US-LG04 — commission per method from the LEDGER: Σ (commission + commission_reversal), grouped by
// the method each row carries. A clawed-back cancellation nets to zero (its reversal row); an
// absorbed one keeps the commission (no reversal) — the same keep semantics, now event-sourced.
const sumCommissionsByMethod = async (
  db: Db,
  org: string,
  agentId: string,
  since?: Date,
) => {
  const rows = await db
    .select({
      method: folioPayments.method,
      total: sql<number>`coalesce(sum(${folioPayments.amount}), 0)`,
    })
    .from(folioPayments)
    .where(
      and(
        eq(folioPayments.organizationId, org),
        eq(folioPayments.collectedBy, agentId),
        inArray(folioPayments.entryType, ['commission', 'commission_reversal']),
        ...(since ? [gt(folioPayments.createdAt, since)] : []),
      ),
    )
    .groupBy(folioPayments.method)
  const totals = zeroByMethod()
  for (const r of rows) {
    if (!r.method) continue
    totals[r.method] = Number(r.total ?? 0)
  }
  return totals
}

// Shape the buckets for the wire (GET /me and each GET /balances row).
const buildSalesBlock = (s: {
  totals: Record<PaymentMethodKey, number>
  counts: Record<PaymentMethodKey, number>
}) => {
  const electronic = ELECTRONIC_METHODS.reduce((sum, m) => sum + s.totals[m], 0)
  return {
    total: s.totals.cash + electronic,
    cash: s.totals.cash,
    electronic,
    by_method: { card: s.totals.card, transfer: s.totals.transfer, link: s.totals.link },
    cash_count: s.counts.cash,
    electronic_count: ELECTRONIC_METHODS.reduce((sum, m) => sum + s.counts[m], 0),
  }
}

const buildCommissionsBlock = (m: Record<PaymentMethodKey, number>) => {
  const electronic = ELECTRONIC_METHODS.reduce((sum, k) => sum + m[k], 0)
  return { total: m.cash + electronic, cash: m.cash, electronic }
}

// Each sum accepts an optional `since` (a Date): when present, only events created strictly
// after it are counted. This lets the same helpers compute both the all-time balance and the
// shift-scoped breakdown (events since the agent's last confirmed drop).
// US-LG04 — cash collected from the LEDGER: Σ signed cash money rows (payment + refund). A cancelled
// folio's negative refund row (dated cancelled_at) nets its cash back out; a physical refund would
// do the same at hand-back. No folio-status filter — cancellation is an event, not an exclusion.
const sumCashCollected = async (
  db: Db,
  org: string,
  agentId: string,
  since?: Date,
) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${folioPayments.amount}), 0)` })
    .from(folioPayments)
    .where(
      and(
        eq(folioPayments.organizationId, org),
        eq(folioPayments.collectedBy, agentId),
        eq(folioPayments.method, 'cash'),
        inArray(folioPayments.entryType, ['payment', 'refund']),
        ...(since ? [gt(folioPayments.createdAt, since)] : []),
      ),
    )
  return Number(row?.total ?? 0)
}

// US-LG04 — commission from the LEDGER: Σ (commission + commission_reversal). A clawed-back
// cancellation nets to zero via its reversal row; an absorbed one keeps the commission (no reversal).
const sumCommissions = async (
  db: Db,
  org: string,
  agentId: string,
  since?: Date,
) => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${folioPayments.amount}), 0)` })
    .from(folioPayments)
    .where(
      and(
        eq(folioPayments.organizationId, org),
        eq(folioPayments.collectedBy, agentId),
        inArray(folioPayments.entryType, ['commission', 'commission_reversal']),
        ...(since ? [gt(folioPayments.createdAt, since)] : []),
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

// US-LG04 — the TECH_DEBT §12a `sumCancellationReversal` hack is GONE. A cancellation now writes its
// own negative reversal rows (refund + commission_reversal) dated at cancelled_at, so a post-
// watermark cancellation of a pre-watermark folio is picked up by the ordinary "Σ events since the
// watermark" window — no special-case, and the frozen balance_after is never rewritten.

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
    // US-AG29: the shift sums are grouped by payment method; the reconciling totals
    // (cash_collected / commission_total) are derived FROM the buckets so the sales
    // block and the balance breakdown can never show two different numbers.
    // The ledger already carries any cancellation reversal as negative rows dated at cancelled_at,
    // so a post-watermark cancellation of a pre-watermark folio is inside this `since` window with
    // no special-casing — the §12a reversal step is gone (US-LG04).
    const salesByMethod = await sumSalesByMethod(db, org, agentId, since)
    const commissionByMethod = await sumCommissionsByMethod(db, org, agentId, since)
    const expenseTotal = await sumExpenses(db, org, agentId, since)
    const payoutsTotal = await sumPayouts(db, org, agentId, since)
    const sales = buildSalesBlock(salesByMethod)
    const commissions = buildCommissionsBlock(commissionByMethod)
    const cashCollected = sales.cash
    const commissionTotal = commissions.total
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
      sales,
      commissions,
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
  const salesByMethod = await sumSalesByMethod(db, org, agentId, since)
  const commissionByMethod = await sumCommissionsByMethod(db, org, agentId, since)
  const sales = buildSalesBlock(salesByMethod)
  const commissions = buildCommissionsBlock(commissionByMethod)
  const cashCollected = sales.cash
  const commissionTotal = commissions.total
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
    sales,
    commissions,
  }
}

// The columns every serializer needs. Keeps the select lists and serializeDrop in lockstep.
interface DropRow {
  id: string
  source: 'agent' | 'admin'
  amount: number
  amountRequested: number | null
  balanceBefore: number
  status: 'pending' | 'confirmed' | 'rejected'
  acknowledgment: AckState
  acknowledgedAt: Date | null
  ackNote: string | null
  ackResolvedBy: string | null
  note: string | null
  reviewedBy: string | null
  reviewedAt: Date | null
  reviewNote: string | null
  createdAt: Date
}

// Shape a cash-drop row for the wire. `agent` is attached only on the admin surface. The
// acknowledgment fields are the EFFECTIVE view (derived auto-sign applied), so the wire is
// consistent regardless of whether the opportunistic sweep has run yet.
const serializeDrop = (
  d: DropRow,
  windowSeconds: number,
  now: number,
  agent?: { id: string; name: string },
) => {
  const ack = ackView(d, windowSeconds, now)
  return {
    id: d.id,
    ...(agent ? { agent } : {}),
    source: d.source,
    amount: d.amount,
    // The agent's original ask when an admin confirmed with a corrected amount; null otherwise.
    amount_requested: d.amountRequested,
    balance_before: d.balanceBefore,
    status: d.status,
    acknowledgment: ack.acknowledgment,
    acknowledged_at: ack.acknowledged_at,
    ack_due_at: ack.ack_due_at,
    ack_note: d.ackNote,
    ack_resolved_by: d.ackResolvedBy,
    note: d.note,
    reviewed_by: d.reviewedBy,
    reviewed_at: tsOrNull(d.reviewedAt),
    review_note: d.reviewNote,
    created_at: toSeconds(d.createdAt),
  }
}

// The column set serializeDrop consumes — spread into every drop select so they never drift.
const dropColumns = {
  id: cashDrops.id,
  source: cashDrops.source,
  amount: cashDrops.amount,
  amountRequested: cashDrops.amountRequested,
  balanceBefore: cashDrops.balanceBefore,
  status: cashDrops.status,
  acknowledgment: cashDrops.acknowledgment,
  acknowledgedAt: cashDrops.acknowledgedAt,
  ackNote: cashDrops.ackNote,
  ackResolvedBy: cashDrops.ackResolvedBy,
  note: cashDrops.note,
  reviewedBy: cashDrops.reviewedBy,
  reviewedAt: cashDrops.reviewedAt,
  reviewNote: cashDrops.reviewNote,
  createdAt: cashDrops.createdAt,
} as const

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
  const windowSeconds = await ackWindowSeconds(db, org)
  const now = nowSeconds()

  // Opportunistic auto-sign sweep (D2): persist the caller's OWN pending obligations whose
  // window has elapsed. Bounded to (org, caller); `acknowledged_at = reviewed_at + window`.
  // This settles real audit rows through normal traffic without a cron; ackView still derives
  // the same state for any row this hasn't reached yet.
  await db
    .update(cashDrops)
    .set({
      acknowledgment: 'auto_signed',
      acknowledgedAt: sql`${cashDrops.reviewedAt} + ${windowSeconds}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(cashDrops.organizationId, org),
        eq(cashDrops.agentId, user.userId),
        eq(cashDrops.acknowledgment, 'pending'),
        isNotNull(cashDrops.reviewedAt),
        lte(cashDrops.reviewedAt, new Date((now - windowSeconds) * 1000)),
      ),
    )

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
    .select(dropColumns)
    .from(cashDrops)
    .where(
      and(eq(cashDrops.organizationId, org), eq(cashDrops.agentId, user.userId)),
    )
    .orderBy(desc(cashDrops.createdAt))
    .limit(MY_DROPS_PAGE + 1)

  const dropsTruncated = dropRows.length > MY_DROPS_PAGE
  const drops = dropRows
    .slice(0, MY_DROPS_PAGE)
    .map((d) => serializeDrop(d, windowSeconds, now))

  // The agent's outstanding signature obligations (US-AG27/AG28): drops whose EFFECTIVE
  // acknowledgment is still `pending` (post-sweep, never auto-signable yet, never disputed).
  //
  // Queried SEPARATELY, not filtered out of `drops`. Deriving it from a capped list would drop a
  // signature obligation off the 51st row — silently, and on the one thing in this payload that is
  // an obligation rather than a record. Stored-`pending` is a tiny set by nature (it is what the
  // agent has not answered yet), so it needs no cap of its own; the effective view still decides,
  // because a window that has elapsed reads as `auto_signed` and owes nothing.
  const ackRows = await db
    .select(dropColumns)
    .from(cashDrops)
    .where(
      and(
        eq(cashDrops.organizationId, org),
        eq(cashDrops.agentId, user.userId),
        eq(cashDrops.acknowledgment, 'pending'),
      ),
    )
    .orderBy(desc(cashDrops.createdAt))

  const pendingAcks = ackRows
    .map((d) => serializeDrop(d, windowSeconds, now))
    .filter((d) => d.acknowledgment === 'pending')
    .map((d) => ({
      id: d.id,
      source: d.source,
      amount: d.amount,
      amount_requested: d.amount_requested,
      balance_before: d.balance_before,
      note: d.note,
      reviewed_at: d.reviewed_at,
      ack_due_at: d.ack_due_at,
    }))

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
      drops,
      // True when this payload does NOT carry the agent's whole history (D12′).
      drops_truncated: dropsTruncated,
      pending_acknowledgments: pendingAcks,
      pending_acknowledgments_count: pendingAcks.length,
      // US-AG29 — shift-scoped cash-vs-electronic read model (display-only).
      sales: derived.sales,
      commissions: derived.commissions,
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
// live derivation and forces agent_id=caller. balance_before in the body is ignored.
//
// US-A34 self-authorization: when an ADMIN files a hand-in, the depositing party and the
// approving party are the same person (this route is caller-scoped — agent_id is always the
// caller), so the drop is born `confirmed` (reviewed_by = self) instead of `pending`. It
// never enters the admin's review queue and opens no acknowledgment window. Accounting is
// unaffected: the balance derivation already counts only confirmed drops, so a self-confirmed
// drop enters the formula exactly as an agent's drop does once an admin confirms it — the
// only thing skipped is the approval step. An agent's drop is ALWAYS `pending`; the role
// check below is the single seam, so self-authorization can never leak to agents.
export const createDrop = async (c: CashContext) => {
  const user = c.get('user')
  const org = user.organizationId
  const input = (await c.req.json()) as CreateDropInput
  const db = getDb(c.env)

  const { balance, pendingDropsTotal } = await deriveBalance(db, org, user.userId)

  // A hand-in can never exceed the company cash the caller is actually holding. The cap is
  // the physical balance minus any drops already pending confirmation (that cash is already
  // pledged), so two pending hand-ins can't together over-commit the drawer. A non-positive
  // available figure means there is nothing to hand in (the company owes the caller).
  const available = balance - pendingDropsTotal
  if (input.amount > available) {
    throw new ApiError(
      'DROP_EXCEEDS_BALANCE',
      400,
      'The hand-in exceeds the cash available to deliver',
    )
  }

  const selfAuthorized = user.role === 'admin'
  const now = new Date()

  const [drop] = await db
    .insert(cashDrops)
    .values({
      id: crypto.randomUUID(),
      organizationId: org,
      agentId: user.userId,
      amount: input.amount,
      balanceBefore: balance,
      // Self-confirmed: mirror reviewDrop's watermark (balance_after = pre-drop balance −
      // amount; `balance` here already excludes this not-yet-inserted drop) and stamp the
      // reviewer as self, the audit marker the UI reads as "auto-confirmada".
      ...(selfAuthorized
        ? {
            status: 'confirmed' as const,
            balanceAfter: balance - input.amount,
            reviewedBy: user.userId,
            reviewedAt: now,
          }
        : { status: 'pending' as const }),
      note: input.note ?? null,
    })
    .returning()

  const windowSeconds = await ackWindowSeconds(db, org)
  return c.json({ drop: serializeDrop(drop, windowSeconds, nowSeconds()) }, 201)
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

// US-A19 — each agent's outstanding balance + SHIFT-SCOPED breakdown (the company's cash
// exposure, reconciliation-ready). The headline `balance` is the authoritative all-time figure
// (the physical cash held); the breakdown (carry_forward + cash_collected − commission_total −
// expense_total + payouts_total) counts only events since the agent's last confirmed drop — the
// SAME view the agent sees on their own /me surface. Built by mapping each org agent through the
// canonical `deriveBalance` (single source of truth), so the dashboard row mirrors /me exactly.
//
// The derivations are independent and fired CONCURRENTLY; each is O(shift) via the balance_after
// watermark (TECH_DEBT §12b), so the dashboard cost is the slowest single derivation, not the
// sum. (If an org ever grew to hundreds of agents, collapse to O(1) queries with conditional
// aggregation over a per-agent watermark window — see admin-shift-scoped-balances.design.md.)
// Ordered by balance desc (largest exposure first).
export const listBalances = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)

  // A balance row is emitted for every cash-holding user, even one with no activity (→ all
  // zeros). Affiliates (external resellers) carry the same running balance + cash-drop flow as
  // agents (affiliate-portal D5), so they fold into the same roster — tagged with their role and
  // company so the admin can tell an in-house agent from a partner at a glance.
  const agents = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      affiliateCompany: affiliateCompanies.name,
    })
    .from(users)
    .leftJoin(affiliateCompanies, eq(affiliateCompanies.id, users.affiliateCompanyId))
    .where(and(eq(users.organizationId, org), inArray(users.role, ['agent', 'affiliate'])))

  const balances = await Promise.all(
    agents.map(async (agent) => {
      const derived = await deriveBalance(db, org, agent.id)
      return {
        agent: { id: agent.id, name: agent.name },
        role: agent.role,
        affiliate_company: agent.affiliateCompany ?? null,
        cash_collected: derived.cashCollected,
        commission_total: derived.commissionTotal,
        expense_total: derived.expenseTotal,
        payouts_total: derived.payoutsTotal,
        carry_forward: derived.carryForward,
        last_drop: derived.lastDrop,
        balance: derived.balance,
        pending_drops_total: derived.pendingDropsTotal,
        pending_drops_count: derived.pendingDropsCount,
        // US-AG29 (D5) — same buckets the agent sees on /me, per row.
        sales: derived.sales,
        commissions: derived.commissions,
      }
    }),
  )

  balances.sort((a, b) => b.balance - a.balance)

  return c.json({ balances })
}

const ACK_STATES = [
  'not_required',
  'pending',
  'signed',
  'auto_signed',
  'disputed',
  'resolved',
] as const

// US-A19 — the drops review queue, org-scoped, newest first. Defaults to status=pending;
// optional agent_id filter, and an optional `ack=` filter (e.g. `ack=disputed` for the
// open-disputes queue). Each row carries its agent (joined).
export const listDrops = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)
  const windowSeconds = await ackWindowSeconds(db, org)
  const now = nowSeconds()

  const statusQ = c.req.query('status')
  const agentQ = c.req.query('agent_id')
  const ackQ = c.req.query('ack')

  const filters = [eq(cashDrops.organizationId, org)]
  if (statusQ === 'pending' || statusQ === 'confirmed' || statusQ === 'rejected') {
    filters.push(eq(cashDrops.status, statusQ))
  } else if (statusQ !== 'all') {
    filters.push(eq(cashDrops.status, 'pending'))
  }
  if (agentQ) filters.push(eq(cashDrops.agentId, agentQ))
  if (ackQ && (ACK_STATES as readonly string[]).includes(ackQ)) {
    filters.push(eq(cashDrops.acknowledgment, ackQ as AckState))
  }

  const rows = await db
    .select({ ...dropColumns, agentId: cashDrops.agentId, agentName: users.name })
    .from(cashDrops)
    .innerJoin(users, eq(cashDrops.agentId, users.id))
    .where(and(...filters))
    .orderBy(desc(cashDrops.createdAt))
    .limit(TEAM_DROPS_PAGE + 1)

  return c.json({
    drops: rows
      .slice(0, TEAM_DROPS_PAGE)
      .map((r) => serializeDrop(r, windowSeconds, now, { id: r.agentId, name: r.agentName })),
    // Matches the seller folio list's contract: the caller can say so rather than imply a whole.
    truncated: rows.length > TEAM_DROPS_PAGE,
  })
}

// Re-read one drop (with its agent) scoped to the caller's org. null if unknown/cross-org.
const readDrop = async (
  db: Db,
  org: string,
  id: string,
  windowSeconds: number,
  now: number,
) => {
  const [r] = await db
    .select({ ...dropColumns, agentId: cashDrops.agentId, agentName: users.name })
    .from(cashDrops)
    .innerJoin(users, eq(cashDrops.agentId, users.id))
    .where(and(eq(cashDrops.id, id), eq(cashDrops.organizationId, org)))
    .limit(1)

  if (!r) return null
  return serializeDrop(r, windowSeconds, now, { id: r.agentId, name: r.agentName })
}

// US-A19 — one drop's detail. 404 cross-org/unknown (no existence leak).
export const getDropDetail = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)

  const drop = await readDrop(db, org, id, await ackWindowSeconds(db, org), nowSeconds())
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

  // US-A28 — an ADJUSTED confirm is a unilateral admin money-move, so it owes the agent a
  // signature. Confirm-as-requested, or a reject, owes none.
  const acknowledgment: AckState =
    input.decision === 'confirmed' && amountRequested !== null
      ? 'pending'
      : 'not_required'

  const now = new Date()
  await db
    .update(cashDrops)
    .set({
      status: input.decision,
      amount,
      amountRequested,
      balanceAfter,
      acknowledgment,
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

  const updated = await readDrop(
    db,
    org,
    id,
    await ackWindowSeconds(db, org),
    nowSeconds(),
  )
  return c.json({ drop: updated })
}

// US-A25 — register a company-to-agent payout (transfer/payroll) to clear a negative
// balance. Immediate (no review): it raises the target's balance by `amount` on next read.
// `agent_id` must name an agent in the admin's org — OR the admin themselves, for a
// self-authorized payout that clears the admin's OWN negative balance (US-A34, symmetric with
// the self-confirmed drop). Payouts have no review workflow, so "self-confirmed" here is just
// permitting the self-target. organization_id / created_by come from context, never the body.
export const registerPayout = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const input = (await c.req.json()) as CreatePayoutInput
  const db = getDb(c.env)

  const isSelf = input.agent_id === admin.userId

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, input.agent_id),
        eq(users.organizationId, org),
        // Otherwise the target must be an agent in the admin's org; self bypasses the role
        // filter so the admin can clear their own balance.
        ...(isSelf ? [] : [inArray(users.role, ['agent', 'affiliate'])]),
      ),
    )
    .limit(1)

  if (!target) {
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

// --- Advanced cash collection (US-A27/A28, US-AG27/AG28) -----------------------

// US-A27 — admin-initiated DIRECT collection. Records a confirmed drop (`source='admin'`) that
// reduces the agent's balance IMMEDIATELY — no pending agent request first — and owes the agent
// a signature (`acknowledgment='pending'`). `agent_id` must name an agent in the admin's org
// (else 404). organization_id / source / status / balance_* come from context/derivation.
export const registerCollection = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const input = (await c.req.json()) as RegisterCollectionInput
  const db = getDb(c.env)

  const [agent] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.id, input.agent_id),
        eq(users.organizationId, org),
        inArray(users.role, ['agent', 'affiliate']),
      ),
    )
    .limit(1)

  if (!agent) {
    throw new ApiError('NOT_FOUND', 404, 'Agent not found')
  }

  // The collection settles like a confirmed drop: snapshot balance_before from the live
  // derivation and stamp the balance_after watermark, so it becomes the agent's new anchor.
  const { balance } = await deriveBalance(db, org, input.agent_id)
  const now = new Date()

  const [drop] = await db
    .insert(cashDrops)
    .values({
      id: crypto.randomUUID(),
      organizationId: org,
      agentId: input.agent_id,
      source: 'admin',
      amount: input.amount,
      balanceBefore: balance,
      balanceAfter: balance - input.amount,
      status: 'confirmed',
      acknowledgment: 'pending',
      note: input.note ?? null,
      reviewedBy: admin.userId,
      reviewedAt: now,
      createdAt: now,
    })
    .returning()

  const windowSeconds = await ackWindowSeconds(db, org)
  return c.json(
    {
      drop: serializeDrop(drop, windowSeconds, nowSeconds(), {
        id: agent.id,
        name: agent.name,
      }),
    },
    201,
  )
}

// Fetch a drop scoped to (org, caller) for an agent acknowledgment transition. null if
// unknown / not owned / cross-org.
const readAgentDrop = (db: Db, org: string, agentId: string, id: string) =>
  db
    .select({
      id: cashDrops.id,
      acknowledgment: cashDrops.acknowledgment,
      acknowledgedAt: cashDrops.acknowledgedAt,
      reviewedAt: cashDrops.reviewedAt,
    })
    .from(cashDrops)
    .where(
      and(
        eq(cashDrops.id, id),
        eq(cashDrops.organizationId, org),
        eq(cashDrops.agentId, agentId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null)

// US-AG27/AG28 — agent SIGNS a pending admin money-move. Flips `pending → signed`. 404
// unknown/not-owned; 409 if the EFFECTIVE acknowledgment is not pending (already signed,
// auto-signed past the window, disputed, resolved, or never owed). Financially inert.
export const acknowledgeDrop = async (c: CashContext) => {
  const user = c.get('user')
  const org = user.organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)

  const drop = await readAgentDrop(db, org, user.userId, id)
  if (!drop) {
    throw new ApiError('NOT_FOUND', 404, 'Cash drop not found')
  }
  const windowSeconds = await ackWindowSeconds(db, org)
  const now = nowSeconds()
  if (ackView(drop, windowSeconds, now).acknowledgment !== 'pending') {
    throw new ApiError('CONFLICT', 409, 'This item is not awaiting your signature')
  }

  const nowDate = new Date()
  await db
    .update(cashDrops)
    .set({ acknowledgment: 'signed', acknowledgedAt: nowDate, updatedAt: nowDate })
    .where(
      and(
        eq(cashDrops.id, id),
        eq(cashDrops.organizationId, org),
        eq(cashDrops.agentId, user.userId),
        eq(cashDrops.acknowledgment, 'pending'),
      ),
    )

  const updated = await readDrop(db, org, id, windowSeconds, now)
  return c.json({ drop: updated })
}

// US-AG27/AG28 — agent DISPUTES a pending admin money-move with a required reason. Flips
// `pending → disputed`; suppresses auto-sign; the balance is UNCHANGED (non-blocking, D5).
// 404 unknown/not-owned; 409 if not effective-pending; 400 empty note (validated upstream).
export const disputeDrop = async (c: CashContext) => {
  const user = c.get('user')
  const org = user.organizationId
  const id = c.req.param('id')
  const input = (await c.req.json()) as DisputeInput
  const db = getDb(c.env)

  const drop = await readAgentDrop(db, org, user.userId, id)
  if (!drop) {
    throw new ApiError('NOT_FOUND', 404, 'Cash drop not found')
  }
  const windowSeconds = await ackWindowSeconds(db, org)
  const now = nowSeconds()
  if (ackView(drop, windowSeconds, now).acknowledgment !== 'pending') {
    throw new ApiError('CONFLICT', 409, 'This item can no longer be disputed')
  }

  const nowDate = new Date()
  await db
    .update(cashDrops)
    .set({ acknowledgment: 'disputed', ackNote: input.note, updatedAt: nowDate })
    .where(
      and(
        eq(cashDrops.id, id),
        eq(cashDrops.organizationId, org),
        eq(cashDrops.agentId, user.userId),
        eq(cashDrops.acknowledgment, 'pending'),
      ),
    )

  const updated = await readDrop(db, org, id, windowSeconds, now)
  return c.json({ drop: updated })
}

// US-A27/A28 (D5) — admin RESOLVES an agent's dispute with a required note. Flips
// `disputed → resolved`, records `ack_resolved_by`, and appends the resolution to `review_note`.
// It does NOT alter any amount or balance (frozen settled history) — a genuine correction is a
// separate compensating payout/collection. 404 unknown/cross-org; 409 if not disputed.
export const resolveDispute = async (c: CashContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id')
  const input = (await c.req.json()) as ResolveDisputeInput
  const db = getDb(c.env)

  const [drop] = await db
    .select({ id: cashDrops.id, acknowledgment: cashDrops.acknowledgment, reviewNote: cashDrops.reviewNote })
    .from(cashDrops)
    .where(and(eq(cashDrops.id, id), eq(cashDrops.organizationId, org)))
    .limit(1)

  if (!drop) {
    throw new ApiError('NOT_FOUND', 404, 'Cash drop not found')
  }
  if (drop.acknowledgment !== 'disputed') {
    throw new ApiError('CONFLICT', 409, 'This cash drop has no open dispute')
  }

  const resolution = `Resolución: ${input.note}`
  const reviewNote = drop.reviewNote ? `${drop.reviewNote} — ${resolution}` : resolution
  const nowDate = new Date()
  await db
    .update(cashDrops)
    .set({
      acknowledgment: 'resolved',
      ackResolvedBy: admin.userId,
      acknowledgedAt: nowDate,
      reviewNote,
      updatedAt: nowDate,
    })
    .where(
      and(
        eq(cashDrops.id, id),
        eq(cashDrops.organizationId, org),
        eq(cashDrops.acknowledgment, 'disputed'),
      ),
    )

  const updated = await readDrop(db, org, id, await ackWindowSeconds(db, org), nowSeconds())
  return c.json({ drop: updated })
}
