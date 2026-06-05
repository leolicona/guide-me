// Cash drawer (corte de caja) types. All money fields are integer minor units —
// render with the helpers in features/catalog/types. Spec: docs/cash-drawer/cash-drawer.spec.md

export type DrawerStatus = 'open' | 'submitted' | 'approved' | 'rejected'

export interface DrawerExpense {
  id: string
  description: string
  amount: number
  created_at: number
}

export interface DrawerIncome {
  folio_count: number
  total_collected: number
  pending_balance: number
}

export interface CashDrawer {
  /** null when no drawer row exists yet (a virtual open day). */
  id: string | null
  /** Attached only on the admin surface. */
  agent?: { id: string; name: string }
  business_date: string
  status: DrawerStatus
  income: DrawerIncome
  expense_total: number
  net_balance: number
  expenses: DrawerExpense[]
  submitted_at: number | null
  reviewed_at: number | null
  review_note: string | null
}

export interface DrawerListItem {
  id: string
  agent: { id: string; name: string }
  business_date: string
  status: DrawerStatus
  total_collected: number
  expense_total: number
  net_balance: number
  folio_count: number
  submitted_at: number | null
  reviewed_at: number | null
}

export type ReviewDecision = 'approved' | 'rejected'
