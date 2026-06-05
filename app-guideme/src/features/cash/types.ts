// Agent continuous cash balance with cash drops (US-AG12/13/14/23/24/25, US-A19/25/26).
// All money fields are integer minor units (centavos) — render with the helpers in
// features/catalog/types. Spec: docs/cash-drops/agent-balance-cash-drops.spec.md
//
// Running balance (server-derived, never sent):
//   balance = cash_collected − commission_total − expense_total
//             − confirmed_drops_total + payouts_total

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

// GET /api/cash/me — the agent's live running balance + breakdown.
export interface AgentBalance {
  cash_collected: number
  commission_total: number
  expense_total: number
  confirmed_drops_total: number
  pending_drops_total: number
  payouts_total: number
  balance: number
  expenses: CashExpense[]
  drops: CashDrop[]
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
