// Agent continuous cash balance with cash drops (US-AG12/13/14/23/24/25, US-A19/25/26).
// All money fields are integer minor units (centavos) — render with the helpers in
// features/catalog/types. Spec: docs/cash-drops/agent-balance-cash-drops.spec.md
//
// Running balance (server-derived, never sent). The authoritative all-time figure is:
//   balance = cash_collected − commission_total − expense_total
//             − confirmed_drops + payouts_total
// The agent's /me breakdown is SHIFT-SCOPED — its components count only events since the
// agent's last confirmed drop, and carry_forward (the balancing term) folds in everything
// before it, so: balance = carry_forward + cash_collected − commission_total − expense_total
//                          + payouts_total.

export type DropStatus = 'pending' | 'confirmed' | 'rejected'
export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'link'

// Agent Balance UX Overhaul (US-AG29). Spec: docs/cash-drops/agent-balance-ux-overhaul.spec.md
// Shift-scoped, display-only read model: `sales.cash` always equals `cash_collected` and
// `commissions.total` always equals `commission_total` — the flat fields remain the
// reconciling figures of the balance invariant.
export interface SalesBreakdown {
  total: number
  cash: number // always equals cash_collected
  electronic: number
  by_method: Record<Exclude<PaymentMethod, 'cash'>, number>
  cash_count: number
  electronic_count: number
}

export interface CommissionBreakdown {
  total: number // always equals commission_total
  cash: number
  electronic: number
}

// Advanced Cash Collection (US-A27/A28, US-AG27/AG28).
// Spec: docs/cash-drops/advanced-cash-collection.spec.md
// `source` — who created the drop: the agent (hand-in) or the admin (direct collection).
// `AckState` — the agent's signature lifecycle on a unilateral admin money-move. Orthogonal
// to DropStatus and financially inert: signing/disputing never changes the balance.
export type DropSource = 'agent' | 'admin'
export type AckState =
  | 'not_required'
  | 'pending'
  | 'signed'
  | 'auto_signed'
  | 'disputed'
  | 'resolved'

export interface CashAgent {
  id: string
  name: string
}

export interface CashExpense {
  id: string
  description: string
  amount: number
  created_at: number
}

export interface CashDrop {
  id: string
  source: DropSource
  amount: number
  /** The agent's original ask when an admin confirmed with a corrected amount; null otherwise. */
  amount_requested: number | null
  balance_before: number
  status: DropStatus
  /** Effective signature state — the server derives auto_signed once the org window elapses. */
  acknowledgment: AckState
  acknowledged_at: number | null
  /** When still awaiting signature: the instant it will auto-sign; null otherwise. */
  ack_due_at: number | null
  /** The agent's dispute reason; null unless disputed/resolved. */
  ack_note: string | null
  ack_resolved_by: string | null
  note: string | null
  reviewed_by: string | null
  reviewed_at: number | null
  review_note: string | null
  created_at: number
  agent?: CashAgent // attached on the admin surface only
}

// One outstanding signature obligation on the agent's /me surface (US-AG27/AG28).
export interface PendingAck {
  id: string
  source: DropSource
  amount: number
  amount_requested: number | null // present on adjusted confirms (US-AG28)
  balance_before: number
  note: string | null
  reviewed_at: number | null
  ack_due_at: number | null // reviewed_at + the org's ack window
}

export interface CashPayout {
  id: string
  agent_id: string
  amount: number
  note: string | null
  created_at: number
}

// The anchor that defines the current shift: the agent's most recent confirmed drop.
export interface CashLastDrop {
  id: string
  amount: number
  balance_before: number
  confirmed_at: number | null
  created_at: number
}

// GET /api/cash/me — the agent's running balance (all-time) with a shift-scoped breakdown.
export interface AgentBalance {
  carry_forward: number // balance carried into the current shift (may be negative); 0 if none
  cash_collected: number // the breakdown components below are scoped to the current shift
  commission_total: number
  expense_total: number
  pending_drops_total: number
  payouts_total: number
  balance: number // authoritative all-time figure (the physical cash held)
  last_drop: CashLastDrop | null // anchor; null when no confirmed drop exists yet
  expenses: CashExpense[] // the current-shift expenses
  drops: CashDrop[] // recent drops, all statuses, for context
  pending_acknowledgments: PendingAck[] // admin money-moves awaiting my signature
  pending_acknowledgments_count: number
  sales: SalesBreakdown // US-AG29 — shift-scoped cash vs electronic split
  commissions: CommissionBreakdown // US-AG29 — commission split by payment bucket
}

// GET /api/cash/balances — one admin row per agent (company cash exposure). SHIFT-SCOPED: the
// breakdown components count only events since the agent's last confirmed drop, with
// carry_forward folding in everything before it, mirroring the agent's own /me view —
//   balance = carry_forward + cash_collected − commission_total − expense_total + payouts_total
// The headline `balance` stays the authoritative all-time figure (the physical cash held).
export interface BalanceListItem {
  agent: CashAgent
  // The cash-holder's role. Affiliates (external resellers) fold into the same roster as
  // in-house agents (affiliate-portal D5); `affiliate_company` names their partner company.
  role: 'agent' | 'affiliate'
  affiliate_company: string | null
  carry_forward: number // balance carried into the current shift (may be negative); 0 if none
  cash_collected: number // the breakdown components below are scoped to the current shift
  commission_total: number
  expense_total: number
  payouts_total: number
  balance: number // authoritative all-time figure (the physical cash held)
  last_drop: CashLastDrop | null // anchor; null when no confirmed drop exists yet
  pending_drops_total: number
  pending_drops_count: number
  sales: SalesBreakdown // US-AG29 — mirrors the agent's own /me buckets
  commissions: CommissionBreakdown
}

// --- Request payloads -------------------------------------------------------

export interface AddExpenseInput {
  description: string
  amount: number
}

export interface CreateDropInput {
  amount: number
  note?: string | null
}

export interface ReviewDropInput {
  decision: 'confirmed' | 'rejected'
  note?: string | null
  /** Adjust-on-confirm: a corrected amount (minor units). Only honoured when confirming. */
  amount?: number
}

export interface CreatePayoutInput {
  agent_id: string
  amount: number
  note?: string | null
}

// US-A27 — admin direct collection (face-to-face). Confirmed immediately server-side.
export interface RegisterCollectionInput {
  agent_id: string
  amount: number
  note?: string | null
}

// US-AG27/AG28 — the dispute reason is required.
export interface DisputeInput {
  note: string
}

// US-A27/A28 (D5) — the resolution note is required; audit-only, no money change.
export interface ResolveDisputeInput {
  note: string
}

export interface DropFilters {
  status?: DropStatus | 'all'
  agentId?: string
  /** Filter by signature state, e.g. 'disputed' for the open-disputes queue. */
  ack?: AckState
}
