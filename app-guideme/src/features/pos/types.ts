// POS (agent point of sale) types. All money fields are integer minor units
// (centavos) — render with the helpers in features/catalog/types.

export interface PosServiceSummary {
  id: string
  name: string
  description: string | null
  base_price: number
  minimum_price: number
  /** Σ remaining over active, future slots. */
  available_spots: number
  /** Earliest active future slot date, or null when none. */
  next_slot_date: string | null
}

export interface PosSlot {
  id: string
  date: string // 'YYYY-MM-DD'
  start_time: string // 'HH:MM'
  capacity: number
  booked: number
  remaining: number
}

export interface PosExtra {
  id: string
  name: string
  price: number
}

export interface PosServiceDetail
  extends Omit<PosServiceSummary, 'available_spots' | 'next_slot_date'> {
  extras: PosExtra[]
  slots: PosSlot[]
}

export type FolioStatus = 'paid' | 'booking' | 'cancelled'

/** US-AG25 — how the agent collected payment. 'card' earns commission but adds no cash debt. */
export type PaymentMethod = 'cash' | 'card'

export interface FolioLineExtra {
  id: string
  extra_id: string
  name: string
  price: number
  quantity: number
}

/** Signature-free echo of the signed QR ticket payload, for rendering labels. */
export interface FolioTicket {
  folio_id: string
  folio_line_id: string
  service_id: string
  slot_id: string
  client_identity: string
  passes_total: number
  expires_at: number
}

export interface FolioLine {
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
  /** Signed access ticket; null for folios sold before the QR feature. */
  qr_token: string | null
  qr: FolioTicket | null
  extras: FolioLineExtra[]
}

export interface Folio {
  id: string
  status: FolioStatus
  customer_name: string | null
  customer_email: string | null
  customer_phone: string | null
  subtotal: number
  discount_total: number
  total: number
  amount_paid: number
  /** How payment was collected (US-AG25). */
  payment_method: PaymentMethod
  /** Set when the folio was cancelled by an admin (US-A21); null otherwise. */
  cancelled_at: number | null
  created_at: number
  lines: FolioLine[]
}

// US-AG20 — lean row for the agent's own read-only sales history. No `agent` block: every
// row is the caller's own (that distinguishes it from the admin org-wide list).
export interface FolioHistoryItem {
  id: string
  customer_name: string | null
  status: FolioStatus
  total: number
  amount_paid: number
  created_at: number
  cancelled_at: number | null
}
