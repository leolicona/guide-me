// POS (agent point of sale) types. All money fields are integer minor units
// (centavos) — render with the helpers in features/catalog/types.

import type { ServiceCategory } from '../catalog/categories'
// US-AG59 — the petition row the folio detail carries. Type-only, so this is erased at build and
// creates no runtime dependency between the two feature modules.
import type { FolioCancellationRequest, RefundStatus } from '../folios/types'

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
  /** US-AG56 — the next departure that actually HAS ROOM inside the availability window,
   * ordered by the (date, time) pair; `null` when the window holds none. Not the earliest
   * *scheduled* departure, which is what this field named before BUG-031 and which may be
   * sold out. Always windowed: «Próximo» means next available in what you are looking at. */
  next_slot_date: string | null
  /** Its naive `HH:MM` wall clock, `null` exactly when `next_slot_date` is. Rendered raw —
   * never through a `Date` — matching `SlotPicker`, so the card and the sheet agree. */
  next_slot_time: string | null
  /** US-AG45 (D4) — the ⚡ Venta Express renders only when true: slot-based, non-zoned, with a
   * sellable departure TODAY (today-anchored regardless of the selected window — D5). The server
   * re-enforces at confirm (EXPRESS_NOT_ELIGIBLE). */
  express_eligible: boolean
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
  /** A stay has no departure; both null keep `PosCatalogItem` exhaustive (US-AG56). */
  next_slot_date: null
  next_slot_time: null
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
  /**
   * US-AG57 (D6) — the lowest total the confirm will accept, in pesos, resolved server-side from
   * the unidad's `max_discount_pct`. Handed over rather than derived here so the field the agent
   * sees and the bound the server enforces cannot drift. `min_total === total` ⇒ no discount is
   * allowed, and the cart renders the total as text rather than a field (D7).
   */
  min_total: number
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
  extends Omit<PosTourCard, 'item_type' | 'has_availability' | 'next_slot_date' | 'next_slot_time'> {
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

// US-LG08 — a folio's DISPLAYED method is derived from its collection rows: one real method, or the
// literal 'Mixto' when a folio was collected more than one way (e.g. cash deposit + transfer
// balance). Only real methods are ever SENT to the server (the settle/checkout pickers); 'Mixto' is
// a read-only display value.
export type DisplayMethod = PaymentMethod | 'Mixto'

// US-AG41/US-A67 — the re-armable electronic-payment verification axis. 'not_required' for cash;
// 'pending' while a transfer awaits an admin; 'verified' once confirmed. Delivery (QR/WhatsApp) is
// blocked while 'pending'.
export type PaymentVerification = 'not_required' | 'pending' | 'verified'

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
  /** US-A22/US-AG54 (line-autonomy) — the line's OWN life, server-derived: money state from its
   * allocations, cancellation from its written stamp, and its own hold clock. Render, never derive. */
  money_state?: FolioStatus
  allocated?: number
  pending_balance?: number
  cancelled_at?: number | null
  cancellation_source?: string | null
  refund_status?: 'none' | 'pending' | 'refunded'
  refund_amount?: number | null
  booking_expires_at?: number | null
  extras: FolioLineExtra[]
}

// US-LG08 — one money movement in a folio's per-payment breakdown (deposit, balance, or a
// cancellation reversal), each with its own method/reference/verification and who collected it.
export interface FolioPaymentEntry {
  id: string
  kind: 'payment' | 'refund'
  method: PaymentMethod
  /** Signed minor units — a refund (cancellation reversal) is negative. */
  amount: number
  reference: string | null
  verification: PaymentVerification
  operator_name: string | null
  collected_at: number
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
  /** How payment was collected — DERIVED from the ledger; 'Mixto' when multi-method (US-LG08). */
  payment_method: DisplayMethod
  /** US-AG41/US-A67 — the transfer's bank reference + the verification gate. Delivery is blocked
   *  while `payment_verification === 'pending'`. */
  payment_reference?: string | null
  payment_verification?: PaymentVerification
  payment_verified_at?: number | null
  /** Set when the folio was cancelled by an admin (US-A21); null otherwise. */
  cancelled_at: number | null
  /** Delivery axis (whatsapp-qr-delivery). portal_link: the WhatsApp/QR portal URL (null until a
   *  QR/portal exists — unpaid booking / pre-feature). tickets_sent_at: the agent sent it (unix
   *  secs). tickets_viewed_at: the tourist opened the portal ("Visto"). */
  portal_link?: string | null
  tickets_sent_at?: number | null
  tickets_viewed_at?: number | null
  /** US-AF13 — the affiliate shift operator who made the sale; null if sold directly. */
  operator_name?: string | null
  /** US-LG08 — the money movements that make up amount_paid (deposit, balance, reversals). */
  payments?: FolioPaymentEntry[]
  /** The seller's own commission on this sale — the per-folio resolution of what `/balance`
   *  already shows aggregated. */
  commission_amount?: number
  // --- US-AG59 (folio-surface-parity D6) --------------------------------------------------------
  // Everything below reached the admin's detail and not the seller's, because the payload was
  // written twice by hand. It is now ONE serializer (`api-turistear/src/utils/folioDetail.ts`),
  // asserted deep-equal by `test/folios/folio-surface-parity.test.ts` — so a field added for one
  // audience reaches the other or fails CI. Do not add a field here without adding it there.
  /** Who cancelled it and why (BUG-034: the seller had neither). */
  cancelled_by?: string | null
  cancellation_reason?: string | null
  /** US-A23 — the cash refund's state and amount. The refund PIN is NEVER serialized: it lives in
   *  the tourist's portal, and learning it in person is what proves the cash changed hands. */
  refund_status?: RefundStatus
  refund_amount?: number | null
  /** The admin's audit note on a no-PIN override confirm. */
  refund_note?: string | null
  refunded_at?: number | null
  refunded_by?: string | null
  /** US-A87 — what a closed apartado left the customer, and until when. Honoured by manual
   *  discount while the checkout cannot spend it — a seller who cannot see it cannot apply it. */
  credit_amount?: number | null
  credit_expires_at?: number | null
  /** US-A85 (D7) — the worst of the folio's lines. */
  fulfillment?: Fulfillment
  /** US-A84 rule 7 — the folio's petition history, newest first. The timeline renders rejected
   *  ones as derived rows; nothing else records that they happened. */
  folio_requests?: FolioCancellationRequest[]
  reminder_status?: ReminderStatus
  reminder_sent_at?: number | null
  reminder_sent_by?: string | null
  created_at: number
  lines: FolioLine[]
}

export type ReminderStatus = 'none' | 'sent'

/** US-A82/US-AG49 — the lean line a LIST row carries: enough to title the card and to render the
 *  WhatsApp `{itinerary}` without a second request. Structurally an `ItineraryLine`. */
/** US-A85 — the folio's sixth axis. Server-DERIVED from `redeemed_count` against the line's own
 *  departure; never stored, never sent. `partial` is unreachable under `qr_redemption_mode =
 *  'all_passes'`, where one scan consumes the whole party (D24). */
export type Fulfillment = 'pending' | 'partial' | 'fulfilled' | 'no_show'

export interface FolioListLine {
  id?: string
  service_name: string
  line_type: 'slot' | 'stay'
  slot_date: string | null
  slot_start_time: string | null
  check_in: string | null
  check_out: string | null
  guests: number | null
  quantity: number
  redeemed_count?: number
  fulfillment?: Fulfillment
  /** US-A89 (D14) — the line's own money state for the card's per-line marks; absent on a
   * legacy line with no allocations (the card simply shows no mark). */
  money_state?: 'paid' | 'booking' | 'cancelled'
}

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
  /** US-AG41/US-A67 — the seller sees the verification state (delivery blocked while pending). */
  payment_method?: PaymentMethod
  payment_verification?: PaymentVerification
  /** US-AF13 — "Vendido por: {name}" (null if the manager/agent sold directly). */
  operator_name?: string | null
  /** US-AG49 — what was sold (card title) and the {itinerary} the ticket send renders. */
  lines?: FolioListLine[]
  /** US-AG49 — the portal link the card's ticket send needs; null before the money clears. */
  portal_link?: string | null
  /** US-AG45 — 'express' has no customer_name by design (D17); never inferred from a null name. */
  sale_mode?: 'standard' | 'express'
}
