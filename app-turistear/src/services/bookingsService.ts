import { request } from './authService'
import type { Folio, PaymentMethod } from '../features/pos/types'

// US-LG03 — how the BALANCE is being collected at settle, independent of the deposit. `method`
// defaults server-side to the deposit's method when omitted; a transfer carries its bank reference.
export interface SettlePayload {
  method: PaymentMethod
  payment_reference?: string
}

// Apartado (booking) management API — distinct from the sale-creation flow (`confirmSale` lives
// in posService). These post-sale actions back the shared `features/bookings` domain. Money
// fields are integer minor units.

/** US-AG07.3 — the atomic reminder-claim result. */
export interface ReminderClaim {
  claimed: boolean
  reminder_sent_at: number | null
  reminder_sent_by: string | null
}

// US-AG07 / US-LG03 — one-shot settlement of a booking: collect the balance (by its own method) →
// paid + QR. A transfer balance defers the QR to admin verification (US-A67).
export const settleBooking = async (id: string, payload?: SettlePayload): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}/settle`, {
    method: 'POST',
    body: payload ? JSON.stringify(payload) : undefined,
  })
  return res.folio
}

// US-AG54 (line-autonomy F3) — settle ONE line: its balance, its QR, its commission; the folio
// completes only with its last live line. Same body contract as the whole-folio settle.
export const settleFolioLine = async (
  id: string,
  lineId: string,
  payload?: SettlePayload,
): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}/lines/${lineId}/settle`, {
    method: 'POST',
    body: payload ? JSON.stringify(payload) : undefined,
  })
  return res.folio
}

// US-AG54 / US-AG07.4 — the agent cancels one apartada line of their own folio; the ladder
// decides the money, same as every other cancellation entrance.
export const cancelBookingLine = async (
  id: string,
  lineId: string,
  reason?: string,
): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}/lines/${lineId}/cancel`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
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

// whatsapp-qr-delivery — record that the tickets were sent over WhatsApp. Two surfaces: the seller
// (agent/affiliate, their own folio) and the admin oversight list.
export interface TicketDelivery {
  tickets_sent_at: number | null
  tickets_viewed_at: number | null
}

export const markTicketsSent = (id: string): Promise<TicketDelivery> =>
  request<TicketDelivery>(`/api/pos/folios/${id}/ticket-delivery`, { method: 'POST' })

export const markTicketsSentAdmin = (id: string): Promise<TicketDelivery> =>
  request<TicketDelivery>(`/api/folios/${id}/ticket-delivery`, { method: 'POST' })

// US-A67 — ADMIN verifies an electronic (transfer) payment: pending → verified. If the folio is
// paid, the server signs the QR + auto-sends the ticket email and returns the updated folio.
export const verifyPayment = async (id: string): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}/verify`, { method: 'POST' })
  return res.folio
}

// US-A67 — ADMIN rejects an electronic payment (money never arrived): voids the folio, releasing
// spots and clawing back commission. `reason` is an optional audit note.
export const rejectPayment = async (id: string, reason?: string): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
  return res.folio
}

// US-AG52 — reagendar a live apartado or a paid sale to another departure of the SAME service.
// Supersedes the retired `reactivateBooking`.
export const rescheduleFolio = (
  folioId: string,
  moves: { folio_line_id: string; to_slot_id: string }[],
) =>
  request<{ folio: unknown }>(`/api/pos/folios/${folioId}/reschedule`, {
    method: 'POST',
    body: JSON.stringify({ moves }),
  })
