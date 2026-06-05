import { request } from './authService'
import type {
  AddExpenseInput,
  AgentBalance,
  BalanceListItem,
  CashDrop,
  CashExpense,
  CashPayout,
  CreateDropInput,
  CreatePayoutInput,
  DropFilters,
  ReviewDropInput,
} from '../features/cash/types'

// Agent continuous cash balance with cash drops. The `/me/*` calls require the agent role;
// the balances/drops/payouts calls require admin (enforced server-side). Money is integer
// minor units. Spec: docs/cash-drops/agent-balance-cash-drops.spec.md

// --- Agent surface (US-AG12/13/14) ---

// US-AG12 — my running balance + breakdown + expenses + my recent drops.
export const getMyBalance = async (): Promise<AgentBalance> => {
  const res = await request<{ balance: AgentBalance }>('/api/cash/me')
  return res.balance
}

// US-AG13 — register an operating expense.
export const addExpense = async (input: AddExpenseInput): Promise<CashExpense> => {
  const res = await request<{ expense: CashExpense }>('/api/cash/me/expenses', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.expense
}

// US-AG13 — remove one of my expenses.
export const deleteExpense = async (id: string): Promise<void> => {
  await request<{ ok: true }>(`/api/cash/me/expenses/${id}`, { method: 'DELETE' })
}

// US-AG14 — register a cash drop (hand-in), pending until the admin confirms.
export const createDrop = async (input: CreateDropInput): Promise<CashDrop> => {
  const res = await request<{ drop: CashDrop }>('/api/cash/me/drops', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.drop
}

// US-AG14 — cancel a still-pending drop.
export const cancelDrop = async (id: string): Promise<void> => {
  await request<{ ok: true }>(`/api/cash/me/drops/${id}`, { method: 'DELETE' })
}

// --- Admin surface (US-A19/25) ---

// US-A19 — each agent's outstanding balance + pending rollup (company cash exposure).
export const listBalances = async (): Promise<BalanceListItem[]> => {
  const res = await request<{ balances: BalanceListItem[] }>('/api/cash/balances')
  return res.balances
}

// US-A19 — the drops review queue (defaults to pending; optional status/agent filters).
export const listDrops = async (filters: DropFilters = {}): Promise<CashDrop[]> => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.agentId) params.set('agent_id', filters.agentId)
  const qs = params.toString()
  const res = await request<{ drops: CashDrop[] }>(`/api/cash/drops${qs ? `?${qs}` : ''}`)
  return res.drops
}

// US-A19 — one drop's detail (with its agent).
export const getDrop = async (id: string): Promise<CashDrop> => {
  const res = await request<{ drop: CashDrop }>(`/api/cash/drops/${id}`)
  return res.drop
}

// US-A19 — confirm receipt or reject a pending drop.
export const reviewDrop = async (
  id: string,
  input: ReviewDropInput,
): Promise<CashDrop> => {
  const res = await request<{ drop: CashDrop }>(`/api/cash/drops/${id}/review`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.drop
}

// US-A25 — register a company-to-agent payout to clear a negative balance.
export const registerPayout = async (
  input: CreatePayoutInput,
): Promise<CashPayout> => {
  const res = await request<{ payout: CashPayout }>('/api/cash/payouts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.payout
}
