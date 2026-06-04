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

export interface FolioLineExtra {
  id: string
  extra_id: string
  name: string
  price: number
  quantity: number
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
  created_at: number
  lines: FolioLine[]
}
