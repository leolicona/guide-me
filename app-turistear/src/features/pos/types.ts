// POS (agent point of sale) types. All money fields are integer minor units
// (centavos) — render with the helpers in features/catalog/types.

import type { ServiceCategory } from '../catalog/categories'

// --- Flattened POS catalog (spec §4.3, D14) — a MIXED list discriminated by `item_type` ---

/** A tour/activity card (the pre-v2 service card shape + the discriminator). */
export interface PosTourCard {
  item_type: 'tour'
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
   * window (a rolling 3-day span or the selected range) has effective remaining > 0. */
  has_availability: boolean
  /** Earliest active slot date inside the availability window, or null when none. */
  next_slot_date: string | null
}

/** v2 (D14) — a lodging UNIT-TYPE card: the parent property is never a card; each active type
 * is, with its exact nightly rate and per-night-windowed availability. */
export interface PosUnitTypeCard {
  item_type: 'unit_type'
  /** The unit type's id (stable key; also what the stay sheet + cart sell). */
  id: string
  service_id: string
  name: string
  /** The parent property, for card context ("Habitación Estándar · Hotel Centro"). */
  property_name: string
  description: string | null
  unit_type: string | null
  category: 'lodging'
  /** Exact per-night base rate (minor units) — not an aggregated "Desde $X". */
  nightly_rate: number
  /** Hard guest cap per room (D12) — pre-caps the stay sheet's guests stepper. */
  max_capacity: number
  /** Per-night min remaining ≥ 1 over the selected window. */
  has_availability: boolean
  /** Min remaining rooms across the window — drives the "Quedan N" badge. */
  remaining: number
  next_slot_date: null
}

export type PosCatalogItem = PosTourCard | PosUnitTypeCard

// --- Accommodation / lodging POS reads (US-AG36 / AG37, v2 unit-type inventory) ---

/** One night's rate inside a stay quote (summed across the quoted rooms). */
export interface StayNight {
  date: string // 'YYYY-MM-DD'
  rate: number // minor units
}

/** A unit type with enough per-night inventory for the whole range × quantity. */
export interface LodgingAvailabilityUnitType {
  unit_type_id: string
  name: string
  unit_type: string | null
  inventory_count: number
  /** Min free rooms across the requested range. */
  min_remaining: number
  beds: number
  base_occupancy: number
  max_capacity: number
  amenities: string[]
  checkin_time: string
  checkout_time: string
  nights: number
  /** Rooms quoted (echoes the request). */
  quantity: number
  /** Stay total (minor units) — rooms × nights × nightly rate + extra-person surcharge (D12). */
  total: number
  per_night: StayNight[]
}

export interface LodgingAvailability {
  check_in: string
  check_out: string
  guests: number
  quantity: number
  unit_types: LodgingAvailabilityUnitType[]
}

/** One day in a unit type's calendar (US-AG37, v2): rooms REMAINING + that day's rate. */
export interface UnitTypeCalendarDay {
  date: string // 'YYYY-MM-DD'
  remaining: number
  rate: number // minor units
}

export interface PosSlot {
  id: string
  date: string // 'YYYY-MM-DD'
  start_time: string // 'HH:MM'
  capacity: number
  booked: number
  remaining: number
  /** US-A64 — per-zone availability, present only for a zoned service's slots. The agent picks a
   * zone; the quantity is bounded by that zone's `remaining`. A closed zone has status 'inactive'. */
  zones?: PosSlotZone[]
}

/** US-A64 — a slot's availability within one physical zone (Turibus deck). */
export interface PosSlotZone {
  zone_id: string
  name: string
  capacity: number
  booked: number
  remaining: number
  status: 'active' | 'inactive'
}

export interface PosExtra {
  id: string
  name: string
  price: number
}

export interface PosServiceDetail
  extends Omit<PosTourCard, 'item_type' | 'has_availability' | 'next_slot_date'> {
  /** US-A64 — when true, each slot carries a `zones` array and the agent must pick a zone. */
  zones_enabled?: boolean
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
  /** US-A64 — the physical zone (null for an unzoned or lodging line). */
  zone_name?: string | null
  /** Lodging stay fields (null for a tour line). For a stay, `quantity` = rooms reserved. */
  unit_type_id?: string | null
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
  /** Delivery axis (whatsapp-qr-delivery). portal_link: the WhatsApp/QR portal URL (null until a
   *  QR/portal exists — unpaid booking / pre-feature). tickets_sent_at: the agent sent it (unix
   *  secs). tickets_viewed_at: the tourist opened the portal ("Visto"). */
  portal_link?: string | null
  tickets_sent_at?: number | null
  tickets_viewed_at?: number | null
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
  /** Delivery axis (whatsapp-qr-delivery) — deliverable = a portal link exists (paid folio); the
   *  sent/viewed stamps drive the Pendiente → Enviado → Visto list badge. */
  deliverable?: boolean
  tickets_sent_at?: number | null
  tickets_viewed_at?: number | null
}
