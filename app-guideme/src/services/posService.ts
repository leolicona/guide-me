import { request } from './authService'
import type { Folio, PosServiceDetail, PosServiceSummary } from '../features/pos/types'

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

export interface ConfirmSaleInput {
  customer_name?: string | null
  customer_email?: string | null
  customer_phone?: string | null
  lines: ConfirmLineInput[]
}

export interface ServiceDetailRange {
  from?: string
  to?: string
}

// US-AG03 / AG10 — POS catalog with availability rollup. `today` pins the org-local
// availability horizon (defaults server-side to the server's UTC date).
export const listPosServices = async (
  today?: string,
): Promise<PosServiceSummary[]> => {
  const query = today ? `?today=${encodeURIComponent(today)}` : ''
  const res = await request<{ services: PosServiceSummary[] }>(
    `/api/pos/services${query}`,
  )
  return res.services
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

// US-AG08 — read back one of the caller agent's own folios (receipt).
export const getFolio = async (id: string): Promise<Folio> => {
  const res = await request<{ folio: Folio }>(`/api/pos/folios/${id}`)
  return res.folio
}
