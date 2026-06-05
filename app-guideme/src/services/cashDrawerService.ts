import { request } from './authService'
import type {
  CashDrawer,
  DrawerExpense,
  DrawerListItem,
  ReviewDecision,
} from '../features/cash-drawer/types'

// Agent's daily cash drawer (US-AG12/13/14) + admin review (US-A19). Money is integer
// minor units. The `/me/*` calls require the agent role; the list/detail/review calls
// require admin (enforced server-side).

export interface AddExpenseInput {
  description: string
  amount: number
  date?: string
}

export interface DrawerFilters {
  status?: string
  date?: string
  agentId?: string
}

// US-AG12 — the caller agent's drawer + summary for a day (defaults to today).
export const getMyDrawer = async (date?: string): Promise<CashDrawer> => {
  const query = date ? `?date=${encodeURIComponent(date)}` : ''
  const res = await request<{ drawer: CashDrawer }>(`/api/cash-drawers/me${query}`)
  return res.drawer
}

// US-AG13 — register an operating expense.
export const addExpense = async (input: AddExpenseInput): Promise<DrawerExpense> => {
  const res = await request<{ expense: DrawerExpense }>('/api/cash-drawers/me/expenses', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.expense
}

// US-AG13 — remove an expense while the drawer is open.
export const deleteExpense = (id: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/api/cash-drawers/me/expenses/${id}`, { method: 'DELETE' })

// US-AG14 — submit the day's closure (snapshot).
export const closeDrawer = async (date?: string): Promise<CashDrawer> => {
  const res = await request<{ drawer: CashDrawer }>('/api/cash-drawers/me/close', {
    method: 'POST',
    body: JSON.stringify(date ? { date } : {}),
  })
  return res.drawer
}

// US-A19 — list closures in the org for review.
export const listDrawers = async (filters: DrawerFilters = {}): Promise<DrawerListItem[]> => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.date) params.set('date', filters.date)
  if (filters.agentId) params.set('agent_id', filters.agentId)
  const qs = params.toString()
  const res = await request<{ drawers: DrawerListItem[] }>(
    `/api/cash-drawers${qs ? `?${qs}` : ''}`,
  )
  return res.drawers
}

// US-A19 — one closure's detail.
export const getDrawer = async (id: string): Promise<CashDrawer> => {
  const res = await request<{ drawer: CashDrawer }>(`/api/cash-drawers/${id}`)
  return res.drawer
}

// US-A19 — approve or reject a submitted closure.
export const reviewDrawer = async (
  id: string,
  decision: ReviewDecision,
  note?: string,
): Promise<CashDrawer> => {
  const res = await request<{ drawer: CashDrawer }>(`/api/cash-drawers/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision, note: note ?? null }),
  })
  return res.drawer
}
