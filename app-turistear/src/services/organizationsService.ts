import { request } from './authService'
import type { CancellationPolicy } from '../features/organization/types'

// The caller's organization, including the booking policy (US-A46). The deposit chip in the
// adaptive checkout (US-AG07.2) reads `booking_min_down_payment_pct` from here.
export interface MyOrganization {
  id: string
  name: string
  booking_min_down_payment_pct: number
  // US-A47 — signed departure offsets (minutes): + = before departure, − = after (grace).
  // salesCutoff closes new walk-in sales; bookingGrace times the unsettled same-day auto-cancel.
  sales_cutoff_offset_minutes: number
  booking_grace_offset_minutes: number
  // US-AG07.1 — pre-departure buffer (hours): a deposit-hold must be settled at least this long
  // before departure; within this window the tighter grace applies (fixes born-expired bookings).
  booking_pre_departure_buffer_hours: number
  /** US-A77 — hours before departure past which an apartado may no longer be opened. 0 = off. */
  booking_creation_cutoff_hours: number
  /** US-A85 (D23) — signed minutes (+ before / − after departure) at which an unscanned paid seat
   *  starts reading as wasted. 0 = the departure instant. Its own number, never one of the two above. */
  no_show_margin_minutes?: number
  /** US-A87 (D10) — how long a closed apartado's credit stays spendable. */
  booking_credit_valid_days?: number
  // US-A60/A63 — lodging org settings. weekend days as ISO weekday ints (0=Sun…6=Sat; default
  // [5,6] = Fri+Sat); free-cancel window (days) + penalty (%) for paid-stay cancellations.
  lodging_weekend_days: number[]
  lodging_free_cancel_days: number
  lodging_cancel_penalty_pct: number
  // whatsapp-qr-delivery D10 — admin-edited message templates; null ⇒ the shipped default is used.
  wa_ticket_template: string | null
  wa_reminder_template: string | null
  // US-A66 — the org's IANA time zone (one of ORG_TIMEZONES). The client anchors catalog "today"
  // and all audit-timestamp display to it.
  timezone: string
  // US-A69/A70/A72 — the cancellation refund ladder. `null` means NO policy is configured, which
  // is what keeps every cancellation on its pre-feature behaviour — so this doubles as the flag
  // for "configure a policy" vs "edit the ladder", and clearing it is the rollback.
  cancellation_policy: CancellationPolicy | null
  // US-A73 — may an agent cancel their own current-shift sale? The endpoint that honours this is
  // not built yet, so nothing reads it in the UI.
  agent_cancellation_enabled: boolean
  // US-A81 (group-redemption) — how a scan consumes a ticket's passes: one per scan (default) or
  // the whole party at once. Read live at scan time from the SCANNING org.
  qr_redemption_mode: 'per_pass' | 'all_passes'
}

export const getMyOrganization = async (): Promise<MyOrganization> => {
  const res = await request<{ organization: MyOrganization }>('/api/organizations/me')
  return res.organization
}

export interface UpdateOrganizationInput {
  booking_min_down_payment_pct?: number
  sales_cutoff_offset_minutes?: number
  booking_grace_offset_minutes?: number
  booking_pre_departure_buffer_hours?: number
  booking_creation_cutoff_hours?: number
  no_show_margin_minutes?: number
  lodging_weekend_days?: number[]
  lodging_free_cancel_days?: number
  lodging_cancel_penalty_pct?: number
  /** US-A87 (D10) — how long a closed apartado's credit stays spendable (1–730). */
  booking_credit_valid_days?: number
  // null resets to the shipped default; a string must contain {portal_link} (server-validated).
  wa_ticket_template?: string | null
  wa_reminder_template?: string | null
  // US-A66 — must be one of ORG_TIMEZONES (server-validated against the curated allow-list).
  timezone?: string
  // US-A69 — the whole ladder, validated server-side as a unit (a malformed one is rejected, never
  // partially stored). `null` clears it and returns cancellations to their pre-feature behaviour.
  cancellation_policy?: CancellationPolicy | null
  // `agent_cancellation_enabled` is deliberately NOT writable — US-A73 is specified, not built,
  // and no endpoint reads it (BUG-028). It stays on `MyOrganization` for when US-AG44 lands.
  // US-A81 — admin-only, org-wide, deliberately not an agent-facing toggle (D7: nothing can
  // un-redeem a pass).
  qr_redemption_mode?: 'per_pass' | 'all_passes'
}

// US-A46 — admin updates the org booking policy.
export const updateMyOrganization = async (
  data: UpdateOrganizationInput,
): Promise<MyOrganization> => {
  const res = await request<{ organization: MyOrganization }>('/api/organizations/me', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
  return res.organization
}
