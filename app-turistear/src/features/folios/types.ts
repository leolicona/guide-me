// Admin folio management (browse + total cancellation, US-A21) types. All money fields are
// integer minor units (centavos) — render with the helpers in features/catalog/types.
// Spec: docs/cancellation/total-folio-cancellation.spec.md

import type {
  DisplayMethod,
  FolioPaymentEntry,
  FolioTicket,
  Fulfillment,
  FolioListLine,
  PaymentMethod,
  PaymentVerification,
} from '../pos/types'

export type { Fulfillment }

export type FolioStatus = 'paid' | 'booking' | 'cancelled'

// US-AG07.3 — last-reminder tracking for the WhatsApp recovery flow.
export type ReminderStatus = 'none' | 'sent'

export interface FolioAgent {
  id: string
  name: string
}

// Lean row shape for the admin list — enough to identify a folio to cancel, plus the
// booking-recovery fields (US-AG07.3/D5) that decorate apartado rows org-wide.
export interface FolioListItem {
  id: string
  agent: FolioAgent
  customer_name: string | null
  customer_phone?: string | null
  status: FolioStatus
  total: number
  amount_paid: number
  pending_balance?: number
  created_at: number
  cancelled_at: number | null
  booking_expires_at?: number | null
  reminder_status?: ReminderStatus
  reminder_sent_at?: number | null
  reminder_sent_by?: string | null
  // whatsapp-qr-delivery — admin oversight of undelivered tickets.
  deliverable?: boolean
  tickets_sent_at?: number | null
  tickets_viewed_at?: number | null
  // US-AG41/US-A67 — payment method + reference + the verification gate (the "Por verificar" queue).
  payment_method?: PaymentMethod
  payment_reference?: string | null
  payment_verification?: PaymentVerification
  // US-A68 — the affiliate shift operator who took the sale; null if sold directly.
  operator_name?: string | null
  // US-A78 — the debt. 'pending' = cancelled, money owed, nobody confirmed the hand-back.
  refund_status?: RefundStatus
  /** US-A87 — what a closed apartado left the customer, and until when. */
  credit_amount?: number | null
  credit_expires_at?: number | null
  refund_amount?: number
  // US-A82 — what was sold (the card's title) and the {itinerary} the ticket send renders.
  lines?: FolioListLine[]
  /** US-A85 — the worst of the folio's lines (D7). Derived server-side; read-only. */
  fulfillment?: Fulfillment
  // US-A82 — the portal link the card's ticket send needs; null until the money clears.
  portal_link?: string | null
  // US-AG45 D17 — 'express' folios carry no customer_name; never infer the mode from a null name.
  sale_mode?: 'standard' | 'express'
  // US-A84 — the two states the folio row could not carry before. 'pending' = a customer is waiting
  // on an answer; 'resolved' = requests exist but none live (the `Con solicitud` facet).
  cancellation_request?: CancellationRequestMark | null
  // Derived server-side from `booking_expires_at`, never stored (apartado-stages S7).
  overdue?: boolean
}

// US-A84 rule 6 — what a folio's cancellation requests amount to, for the row.
export type CancellationRequestMark = 'pending' | 'resolved'

export interface FolioLineExtra {
  id: string
  extra_id: string
  name: string
  price: number
  quantity: number
}

export interface FolioDetailLine {
  id: string
  /** 'slot' (tour) or 'stay' (lodging); absent on pre-feature folios → treat as slot. */
  line_type?: 'slot' | 'stay'
  service_id: string
  slot_id: string | null
  service_name: string
  slot_date: string | null
  slot_start_time: string | null
  /** Lodging stay fields (null for a tour line). For a stay, `quantity` = rooms reserved. */
  unit_type_id?: string | null
  check_in?: string | null
  check_out?: string | null
  guests?: number | null
  nights?: number | null
  quantity: number
  /** US-A85 — the counts the fulfilment axis is derived from; server-derived, read-only. */
  redeemed_count?: number
  fulfillment?: Fulfillment
  base_price: number
  minimum_price: number
  unit_price: number
  line_total: number
  /** US-A22 (line-autonomy F2) — the line's OWN life, server-derived from its allocations
   * (money) and its written cancellation stamp. The client renders these; it never derives. */
  money_state?: FolioStatus
  allocated?: number
  pending_balance?: number
  cancelled_at?: number | null
  cancellation_source?: string | null
  refund_status?: RefundStatus
  refund_amount?: number | null
  /** US-AG54 (D5) — the line's own hold clock, for its countdown. */
  booking_expires_at?: number | null
  /** US-A64 — the physical zone (null for an unzoned or lodging line). */
  zone_name?: string | null
  /** The signed access ticket and its signature-free echo. US-A93: both surfaces receive them —
   *  the admin taking the "my QR doesn't scan" call has to see what the customer is holding. */
  qr_token?: string | null
  qr?: FolioTicket | null
  extras: FolioLineExtra[]
}

export interface FolioDetail {
  id: string
  /** US-A85 (D7) — the worst of the folio's lines. */
  fulfillment?: Fulfillment
  agent: FolioAgent
  // US-A68 — the affiliate shift operator who took the sale; null if sold directly.
  operator_name?: string | null
  status: FolioStatus
  customer_name: string | null
  customer_email: string | null
  customer_phone: string | null
  // US-AG41/US-A67 — payment method + reference + verification gate (drives verify/reject actions).
  // US-LG08 — DERIVED from the collection rows, so it can be the literal 'Mixto'. Always sent:
  // this is the display value, never an input.
  payment_method: DisplayMethod
  payment_reference?: string | null
  payment_verification?: PaymentVerification
  payment_verified_at?: number | null
  subtotal: number
  discount_total: number
  total: number
  amount_paid: number
  // US-AG07/D5 — apartado state for the booking banner + Liquidar/Reactivar on the detail.
  pending_balance?: number
  booking_expires_at?: number | null
  reminder_status?: ReminderStatus
  reminder_sent_at?: number | null
  reminder_sent_by?: string | null
  cancelled_at: number | null
  cancelled_by: string | null
  cancellation_reason: string | null
  // US-A23 / US-T05 — cash refund tracking. `pending` once a tourist's cancellation request
  // is approved on a paid folio; `refunded` after the admin confirms the hand-back. The
  // refund PIN itself is NEVER serialized here — it lives only in the tourist's portal, and
  // the admin learns it from the tourist in person (that is the proof of hand-back).
  refund_status: RefundStatus
  refund_amount: number | null
  refund_note: string | null // the admin's audit note on a no-PIN override confirm
  refunded_at: number | null
  refunded_by: string | null
  /** US-A87 — what a closed apartado left the customer, and until when. Honoured by manual
   * discount while the checkout cannot spend it. */
  credit_amount?: number | null
  credit_expires_at?: number | null
  // whatsapp-qr-delivery — portal_link drives the admin Reenviar action; sent/viewed → the badge.
  portal_link?: string | null
  tickets_sent_at?: number | null
  tickets_viewed_at?: number | null
  /** The seller's commission on this sale — the per-folio resolution of `/balance`'s aggregate. */
  commission_amount?: number
  /** US-LG08 — the money movements that make up `amount_paid` (deposit, balance, reversals). */
  payments?: FolioPaymentEntry[]
  created_at: number
  lines: FolioDetailLine[]
  // US-A84 rule 7 — the folio's petition history, newest first. Rendered by the timeline: a
  // rejected request left the folio untouched, so no event records it and its derived row there
  // is the only surface that shows it ever happened.
  folio_requests?: FolioCancellationRequest[]
}

// One row of a folio's own request history (US-A84 D2). Leaner than `CancellationRequest`, which
// carries folio context the detail page already has.
export interface FolioCancellationRequest {
  id: string
  /** US-AG52 (D13) — what the petition asks for. Absent on pre-rename rows → 'cancellation'. */
  kind?: 'cancellation' | 'reschedule'
  status: CancellationRequestStatus
  reason: string | null
  resolution_note: string | null
  resolved_by: string | null
  resolved_at: number | null
  created_at: number
  /** Reschedule-only: the line to move and the requested destination, resolved to a human date. */
  folio_line_id?: string | null
  to_slot_id?: string | null
  to_slot_date?: string | null
  to_slot_start_time?: string | null
}

// US-A24 / US-AG53 — one row of the folio's narrative, embedded oldest-first in BOTH detail GETs
// (docs/folios/folio-timeline.spec.md D5). Server-derived in its entirety; display-only — no money
// or state computation may read it (rule 7).
export type FolioEventType =
  | 'created'
  | 'payment'
  | 'payment_verified'
  | 'transfer_rejected'
  | 'tickets_sent'
  | 'tickets_viewed'
  | 'reminder_sent'
  | 'rescheduled'
  | 'cancelled'
  | 'refund_confirmed'

export interface FolioEvent {
  id: string
  type: FolioEventType
  at: number
  /** Resolved at read (D10). null ⇒ Sistema (the sweep) — or Cliente on `tickets_viewed`. */
  actor: { id: string; name: string | null } | null
  operator_name: string | null
  backfilled: boolean
  /** Shape per event type (spec § Data Model); amounts in minor units. Backfilled rows may omit
   * keys that were unknowable retroactively (a payment's `kind`, a reschedule's `origin`). */
  payload: Record<string, unknown> | null
}

export interface FolioFilters {
  status?: FolioStatus
  date?: string
  agentId?: string
  // US-A67 — the "Por verificar" queue filters to electronic payments awaiting an admin.
  verification?: PaymentVerification
  // US-A78 — refunds still owed, oldest first.
  refundStatus?: RefundStatus
  // US-A79 — apartados past `booking_expires_at`. Derived server-side, never stored.
  overdue?: boolean
  // US-A83 — the two filters that reach past the load window: an inclusive ORG-LOCAL day range…
  from?: string
  to?: string
  // …and the free-text query, matched against the same five fields the client matches locally.
  q?: string
}

// --- Tourist cancellation requests + refund tracking (US-T04/T05, US-A23) ---
// Spec: docs/tourist-portal/tourist-self-service-portal.spec.md

export type RefundStatus = 'none' | 'pending' | 'refunded'
export type CancellationRequestStatus = 'pending' | 'approved' | 'rejected'

// One row in the admin review queue: the tourist's request plus enough folio context to
// decide without opening the detail.
export interface CancellationRequest {
  id: string
  folio_id: string
  status: CancellationRequestStatus
  reason: string | null // the tourist's stated reason
  resolution_note: string | null // the admin's note (required on reject)
  resolved_by: string | null
  resolved_at: number | null
  created_at: number
  folio: {
    id: string
    customer_name: string | null
    status: FolioStatus
    total: number
    amount_paid: number
  }
}

export interface RejectCancellationRequestInput {
  note: string
}

// Exactly one of `pin` (the tourist's portal PIN — primary) or `override_note`
// (lost-link escape hatch, audited).
export interface ConfirmRefundInput {
  pin?: string
  override_note?: string
}
