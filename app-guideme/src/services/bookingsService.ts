import { request } from './authService'
import type { Folio } from '../features/pos/types'

// Apartado (booking) management API — distinct from the sale-creation flow (`confirmSale` lives
// in posService). These post-sale actions back the shared `features/bookings` domain. Money
// fields are integer minor units.

/** US-AG07.3 — the atomic reminder-claim result. */
export interface ReminderClaim {
  claimed: boolean
  reminder_sent_at: number | null
  reminder_sent_by: string | null
}

// US-AG07 — one-shot settlement of a booking: collect the balance → paid + QR.
export const settleBooking = async (id: string): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}/settle`, {
    method: 'POST',
  })
  return res.folio
}

// US-AG07.4 — manual cancellation of a booking (release spots; deposit retained).
export const cancelBooking = async (id: string, reason?: string): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
  return res.folio
}

// US-AG07.3 — claim the WhatsApp reminder (atomic; call BEFORE opening WhatsApp).
export const claimReminder = async (
  id: string,
  force = false,
): Promise<ReminderClaim> =>
  request<ReminderClaim>(`/api/pos/folios/${id}/reminder`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  })

// US-AG07.5 — reactivate an expired booking when capacity allows.
export const reactivateBooking = async (id: string): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}/reactivate`, {
    method: 'POST',
  })
  return res.folio
}
