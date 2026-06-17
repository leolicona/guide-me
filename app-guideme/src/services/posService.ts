import { request } from './authService'
import type {
  Folio,
  FolioHistoryItem,
  FolioStatus,
  PosServiceDetail,
  PosServiceSummary,
} from '../features/pos/types'

// US-AG03 / AG04 / AG05 / AG06 / AG08 — agent-facing POS. All endpoints require
// the `agent` role (enforced server-side). Money fields are integer minor units.

export interface ConfirmExtraInput {
  extra_id: string
  quantity: number
}

export interface ConfirmLineInput {
  slot_id: string
  quantity: number
  /** Discounted unit price (minor units); server re-validates against [minimum_price, base_price]. */
  unit_price: number
  extras?: ConfirmExtraInput[]
}

/** How the agent collected payment. 'card' earns commission but adds no cash debt (US-AG25). */
export type PaymentMethod = 'cash' | 'card'

export interface ConfirmSaleInput {
  customer_name?: string | null
  customer_email?: string | null
  customer_phone?: string | null
  /** US-AG25 — collection channel. Server defaults to 'cash' when omitted. */
  payment_method?: PaymentMethod
  /** US-AG07 — present ⇒ BOOKING mode: the deposit (minor units). Requires a dialable phone.
   *  Absent ⇒ a normal full paid sale. */
  down_payment?: number
  lines: ConfirmLineInput[]
}

/** US-AG07.3 — the atomic reminder-claim result. */
export interface ReminderClaim {
  claimed: boolean
  reminder_sent_at: number | null
  reminder_sent_by: string | null
}

export interface ServiceDetailRange {
  from?: string
  to?: string
}

// US-AG03 / AG10 / AG30 — POS catalog with a lightweight windowed availability flag.
// `today` pins the org-local anchor (defaults server-side to the server's UTC date);
// `date` collapses the availability window to that single day (omit for the default
// rolling 3-day window).
export const listPosServices = async (
  today?: string,
  date?: string,
): Promise<PosServiceSummary[]> => {
  const params = new URLSearchParams()
  if (today) params.set('today', today)
  if (date) params.set('date', date)
  const qs = params.toString()
  const res = await request<{ services: PosServiceSummary[] }>(
    `/api/pos/services${qs ? `?${qs}` : ''}`,
  )
  return res.services
}

// US-AG35 — month availability for the POS calendar Bottom Sheet. `month` is `YYYY-MM`;
// the server owns the scan range (first…last of that month) and never returns past days.
// Returns the ascending list of `YYYY-MM-DD` dates that have a sellable slot.
export const getPosAvailabilityDays = async (
  month: string,
  today?: string,
): Promise<string[]> => {
  const params = new URLSearchParams({ month })
  if (today) params.set('today', today)
  const res = await request<{ days: string[] }>(
    `/api/pos/availability/days?${params.toString()}`,
  )
  return res.days
}

// US-AG03 / AG04 / AG05 — active service detail (active extras + active future slots).
export const getPosService = async (
  id: string,
  range?: ServiceDetailRange,
): Promise<PosServiceDetail> => {
  const params = new URLSearchParams()
  if (range?.from) params.set('from', range.from)
  if (range?.to) params.set('to', range.to)
  const qs = params.toString()
  const res = await request<{ service: PosServiceDetail }>(
    `/api/pos/services/${id}${qs ? `?${qs}` : ''}`,
  )
  return res.service
}

// US-AG08 — confirm the cart → unique folio. Server owns all totals.
export const confirmSale = async (data: ConfirmSaleInput): Promise<Folio> => {
  const res = await request<{ folio: Folio }>('/api/pos/folios', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.folio
}

// US-AG08 / AG21 — read back one of the caller agent's own folios (receipt + history detail).
export const getFolio = async (id: string): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}`)
  return res.folio
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

export interface MyFolioFilters {
  status?: FolioStatus
  date?: string
}

// US-AG20 — the caller agent's own folio history. Server scopes to the caller (no agent_id).
export const listMyFolios = async (
  filters: MyFolioFilters = {},
): Promise<FolioHistoryItem[]> => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.date) params.set('date', filters.date)
  const qs = params.toString()
  const res = await request<{ folios: FolioHistoryItem[] }>(
    `/api/pos/folios${qs ? `?${qs}` : ''}`,
  )
  return res.folios
}
