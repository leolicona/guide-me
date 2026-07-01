// POS (agent point of sale) types. All money fields are integer minor units
// (centavos) — render with the helpers in features/catalog/types.

import type { ServiceCategory } from '../catalog/categories'

export interface PosServiceSummary {
  id: string
  name: string
  description: string | null
  base_price: number
  minimum_price: number
  /** US-A36 — capacity mode. When true the client may sell up to `flex_capacity_pct`% extra
   * spots per slot (Effective Capacity); the server enforces the same ceiling at confirm. */
  is_flexible: boolean
  flex_capacity_pct: number
  /** US-A37 — primary category (null for a pre-migration service); seeds the POS filter chips. */
  category: ServiceCategory | null
  /** US-AG30 — lightweight availability flag: true when ≥ 1 active slot inside the availability
   * window (a rolling 3-day span or the selected date) has effective remaining > 0. Replaces the
   * Σ-remaining count — the per-slot count lives on the service-detail read. */
  has_availability: boolean
  /** Earliest active slot date inside the availability window, or null when none. */
  next_slot_date: string | null
  /** US-AG36 — lodging only: the lowest unit nightly rate (minor units), for "Desde $X / noche".
   * Absent/0 for non-lodging services. */
  from_nightly_rate?: number
}

// --- Accommodation / lodging POS reads (US-AG36 / AG37) ---

/** One night's rate inside a stay quote. */
export interface StayNight {
  date: string // 'YYYY-MM-DD'
  rate: number // minor units
}

/** A unit available for a whole [check_in, check_out) range, with its computed total. */
export interface LodgingAvailabilityUnit {
  unit_id: string
  name: string
  unit_type: string | null
  beds: number
  base_occupancy: number
  max_capacity: number
  amenities: string[]
  checkin_time: string
  checkout_time: string
  nights: number
  /** Stay total (minor units) — nights × nightly rate + extra-person surcharge. */
  total: number
  per_night: StayNight[]
}

export interface LodgingAvailability {
  check_in: string
  check_out: string
  guests: number
  units: LodgingAvailabilityUnit[]
}

/** One day in a unit's availability calendar (US-AG37). */
export interface UnitCalendarDay {
  date: string // 'YYYY-MM-DD'
  status: 'available' | 'blocked' | 'booked'
  rate: number // minor units
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
  extends Omit<PosServiceSummary, 'has_availability' | 'next_slot_date'> {
  extras: PosExtra[]
  slots: PosSlot[]
}

export type FolioStatus = 'paid' | 'booking' | 'cancelled'

/**
 * US-AG25/AG29 — how the agent collected payment. Every non-cash method is electronic:
 * it earns commission but adds no cash debt.
 */
export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'link'

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
  /** 'slot' (tour) or 'stay' (lodging). Absent on folios read before this feature → treat as slot. */
  line_type?: 'slot' | 'stay'
  service_id: string
  /** Null for a lodging stay line. */
  slot_id: string | null
  service_name: string
  /** Null for a lodging stay line. */
  slot_date: string | null
  slot_start_time: string | null
  /** Lodging stay fields (null for a tour line). */
  unit_id?: string | null
  check_in?: string | null
  check_out?: string | null
  guests?: number | null
  nights?: number | null
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
  /** US-AG07 — total − amount_paid (present on a booking; 0 once paid). */
  pending_balance?: number
  /** US-AG07 — booking hold expiry (unix secs); null for a non-booking folio. */
  booking_expires_at?: number | null
  /** How payment was collected (US-AG25). */
  payment_method: PaymentMethod
  /** Set when the folio was cancelled by an admin (US-A21); null otherwise. */
  cancelled_at: number | null
  created_at: number
  lines: FolioLine[]
}

export type ReminderStatus = 'none' | 'sent'

// US-AG20 / US-AG07.3 — lean row for the agent's own folio history & the Apartados dashboard.
export interface FolioHistoryItem {
  id: string
  customer_name: string | null
  /** US-AG07.3 — phone for the WhatsApp recovery deep link. */
  customer_phone?: string | null
  status: FolioStatus
  total: number
  amount_paid: number
  /** US-AG07.3 — total − amount_paid; the prominent figure on a booking card. */
  pending_balance?: number
  created_at: number
  cancelled_at: number | null
  /** US-AG07.3 — booking expiry (unix secs); drives the urgency sort + border. */
  booking_expires_at?: number | null
  reminder_status?: ReminderStatus
  reminder_sent_at?: number | null
  reminder_sent_by?: string | null
}
