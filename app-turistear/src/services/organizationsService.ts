import { request } from './authService'

// The caller's organization, including the booking policy (US-A46). The deposit chip in the
// adaptive checkout (US-AG07.2) reads `booking_min_down_payment_pct` from here.
export interface MyOrganization {
  id: string
  name: string
  booking_min_down_payment_pct: number
  booking_hold_days: number
  // US-A47 — signed departure offsets (minutes): + = before departure, − = after (grace).
  // salesCutoff closes new walk-in sales; bookingGrace times the unsettled same-day auto-cancel.
  sales_cutoff_offset_minutes: number
  booking_grace_offset_minutes: number
  // US-A60/A63 — lodging org settings. weekend days as ISO weekday ints (0=Sun…6=Sat; default
  // [5,6] = Fri+Sat); free-cancel window (days) + penalty (%) for paid-stay cancellations.
  lodging_weekend_days: number[]
  lodging_free_cancel_days: number
  lodging_cancel_penalty_pct: number
  // whatsapp-qr-delivery D10 — admin-edited message templates; null ⇒ the shipped default is used.
  wa_ticket_template: string | null
  wa_reminder_template: string | null
}

export const getMyOrganization = async (): Promise<MyOrganization> => {
  const res = await request<{ organization: MyOrganization }>('/api/organizations/me')
  return res.organization
}

export interface UpdateOrganizationInput {
  booking_min_down_payment_pct?: number
  booking_hold_days?: number
  sales_cutoff_offset_minutes?: number
  booking_grace_offset_minutes?: number
  lodging_weekend_days?: number[]
  lodging_free_cancel_days?: number
  lodging_cancel_penalty_pct?: number
  // null resets to the shipped default; a string must contain {portal_link} (server-validated).
  wa_ticket_template?: string | null
  wa_reminder_template?: string | null
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
