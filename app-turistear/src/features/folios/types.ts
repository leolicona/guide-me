// Admin folio management (browse + total cancellation, US-A21) types. All money fields are
// integer minor units (centavos) — render with the helpers in features/catalog/types.
// Spec: docs/cancellation/total-folio-cancellation.spec.md

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
  // US-AG07/D5 — apartado state for the booking banner + Liquidar/Reactivar on the detail.
  pending_balance?: number
  booking_expires_at?: number | null
  reminder_status?: ReminderStatus
  reminder_sent_at?: number | null
  reminder_sent_by?: string | null
  cancelled_at: number | null
  cancelled_by: string | null
  cancellation_reason: string | null
  // US-A26 — true when the agent's commission was clawed back on cancellation.
  cancellation_clawback: boolean
  // US-A23 / US-T05 — cash refund tracking. `pending` once a tourist's cancellation request
  // is approved on a paid folio; `refunded` after the admin confirms the hand-back. The
  // refund PIN itself is NEVER serialized here — it lives only in the tourist's portal, and
  // the admin learns it from the tourist in person (that is the proof of hand-back).
  refund_status: RefundStatus
  refund_amount: number | null
  refund_note: string | null // the admin's audit note on a no-PIN override confirm
  refunded_at: number | null
  refunded_by: string | null
  created_at: number
  lines: FolioDetailLine[]
}

export interface FolioFilters {
  status?: FolioStatus
  date?: string
  agentId?: string
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

// US-A26 still applies on a tourist-initiated cancellation: the admin chooses whether the
// agent's commission is clawed back when approving.
export interface ApproveCancellationRequestInput {
  clawback?: boolean
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
