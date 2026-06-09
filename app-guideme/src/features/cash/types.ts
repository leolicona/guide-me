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
export type PaymentMethod = 'cash' | 'card'

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
  amount: number
  /** The agent's original ask when an admin confirmed with a corrected amount; null otherwise. */
  amount_requested: number | null
  balance_before: number
  status: DropStatus
  note: string | null
  reviewed_by: string | null
  reviewed_at: number | null
  review_note: string | null
  created_at: number
  agent?: CashAgent // attached on the admin surface only
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
}

// GET /api/cash/balances — one admin row per agent (company cash exposure).
export interface BalanceListItem {
  agent: CashAgent
  cash_collected: number
  commission_total: number
  expense_total: number
  confirmed_drops_total: number
  payouts_total: number
  balance: number
  pending_drops_total: number
  pending_drops_count: number
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

export interface DropFilters {
  status?: DropStatus | 'all'
  agentId?: string
}
