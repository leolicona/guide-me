// Admin folio management (browse + total cancellation, US-A21) types. All money fields are
// integer minor units (centavos) — render with the helpers in features/catalog/types.
// Spec: docs/cancellation/total-folio-cancellation.spec.md

export type FolioStatus = 'paid' | 'booking' | 'cancelled'

export interface FolioAgent {
  id: string
  name: string
}

// Lean row shape for the admin list — enough to identify a folio to cancel.
export interface FolioListItem {
  id: string
  agent: FolioAgent
  customer_name: string | null
  status: FolioStatus
  total: number
  amount_paid: number
  created_at: number
  cancelled_at: number | null
}

export interface FolioLineExtra {
  id: string
  extra_id: string
  name: string
  price: number
  quantity: number
}

export interface FolioDetailLine {
  id: string
  service_id: string
  slot_id: string
  service_name: string
  slot_date: string
  slot_start_time: string
  quantity: number
  base_price: number
  minimum_price: number
  unit_price: number
  line_total: number
  extras: FolioLineExtra[]
}

export interface FolioDetail {
  id: string
  agent: FolioAgent
  status: FolioStatus
  customer_name: string | null
  customer_email: string | null
  customer_phone: string | null
  subtotal: number
  discount_total: number
  total: number
  amount_paid: number
  cancelled_at: number | null
  cancelled_by: string | null
  cancellation_reason: string | null
  created_at: number
  lines: FolioDetailLine[]
}

export interface FolioFilters {
  status?: FolioStatus
  date?: string
  agentId?: string
}
