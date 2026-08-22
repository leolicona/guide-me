import { request } from './authService'
import type {
  Folio,
  FolioHistoryItem,
  FolioStatus,
  PosCatalogItem,
  PosServiceDetail,
} from '../features/pos/types'
import type { FolioEvent } from '../features/folios/types'

// US-AG03 / AG04 / AG05 / AG06 / AG08 — agent-facing POS. All endpoints require
// the `agent` role (enforced server-side). Money fields are integer minor units.

export interface ConfirmExtraInput {
  extra_id: string
  quantity: number
}

export interface ConfirmSlotLineInput {
  slot_id: string
  /** US-A64 — the physical zone to sell into. Required on a zoned service, refused otherwise
   * (the server enforces). A split party is one line per zone on the same slot. */
  zone_id?: string
  quantity: number
  /** Discounted unit price (minor units); server re-validates against [minimum_price, base_price]. */
  unit_price: number
  extras?: ConfirmExtraInput[]
}

// US-AG38 (v2) — a lodging stay line: `quantity` rooms of a unit type + range + total guests
// (the server re-quotes the total via the D12 even-split engine).
export interface ConfirmStayLineInput {
  unit_type_id: string
  check_in: string
  check_out: string
  guests: number
  quantity: number
  /**
   * US-AG57 — the agent's discounted total for the WHOLE line. Sent ONLY when it differs from the
   * quote, so an undiscounted sale puts the exact same bytes on the wire as before this feature.
   */
  unit_price?: number
}

/** A cart line is either a tour slot or a lodging stay. */
export type ConfirmLineInput = ConfirmSlotLineInput | ConfirmStayLineInput

/** How the agent collected payment. Every non-cash method is electronic — it earns commission but
 *  adds no cash debt (US-AG25/AG29). US-AG41: the POS checkout currently offers only cash + transfer
 *  (card/link stay in the union for historical folios). */
export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'link'

export interface ConfirmSaleInput {
  /** US-AG45 — 'express' is the ⚡ one-sheet cash walk-up (one slot line, no extras, full cash,
   *  phone-only). Omitted/'standard' keeps every existing rule, including the required name. */
  sale_mode?: 'standard' | 'express'
  /** US-AG45 (D21) — client-generated replay guard: a double-tap or a retry over bad signal
   *  re-sends the same key and gets the SAME folio back instead of selling twice. */
  idempotency_key?: string
  customer_name?: string | null
  customer_email?: string | null
  customer_phone?: string | null
  /** US-AG25 — collection channel. Server defaults to 'cash' when omitted. */
  payment_method?: PaymentMethod
  /** US-AG41 — the transfer's bank reference; required by the server iff payment_method='transfer'. */
  payment_reference?: string | null
  /** US-AG07 — present ⇒ BOOKING mode: the deposit (minor units). Requires a dialable phone.
   *  Absent ⇒ a normal full paid sale. */
  down_payment?: number
  lines: ConfirmLineInput[]
}

export interface ServiceDetailRange {
  from?: string
  to?: string
}

// US-AG03 / AG10 / AG30 / AG35 — flattened POS catalog (v2, D14): a MIXED list of tour cards
// and lodging unit-type cards, discriminated by `item_type`. `today` pins the org-local anchor
// (defaults server-side to the server's UTC date); `from`/`to` bound the availability window to
// the selected semantic range (a bare `from` = a single day). Omit both for the default window.
export const listPosServices = async (
  today?: string,
  from?: string,
  to?: string,
): Promise<PosCatalogItem[]> => {
  const params = new URLSearchParams()
  if (today) params.set('today', today)
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const qs = params.toString()
  const res = await request<{ services: PosCatalogItem[] }>(
    `/api/pos/services${qs ? `?${qs}` : ''}`,
  )
  return res.services
}

// US-AG35 — month availability for the POS calendar Bottom Sheet. `month` is `YYYY-MM`;
// the server owns the scan range (first…last of that month) and never returns past days.
// `categories` (US-A37) scopes the dots to the agent's selected category filter; omit or
// pass an empty list for "all categories". Returns the ascending list of `YYYY-MM-DD`
// dates that have a sellable slot.
export const getPosAvailabilityDays = async (
  month: string,
  today?: string,
  categories?: readonly string[],
): Promise<string[]> => {
  const params = new URLSearchParams({ month })
  if (today) params.set('today', today)
  if (categories && categories.length > 0) params.set('categories', categories.join(','))
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

// US-AG47 — void the seller's OWN Express sale inside the 60-second window (undelivered,
// unscanned): seats released, payment + commission ledger rows fully reversed, refund recorded
// as handed back on the spot. 409 VOID_WINDOW_CLOSED once any guard fails.
export interface VoidExpressResult {
  id: string
  status: 'cancelled'
  refund_amount: number
  released_seats: number
}

export const voidExpressSale = async (id: string): Promise<VoidExpressResult> =>
  request<VoidExpressResult>(`/api/pos/folios/${id}/void`, { method: 'POST' })

// What cancelling this folio RIGHT NOW would cost. The server computes it with the same function
// the cancel endpoint uses, so the figure shown before confirming is the figure that gets written.
// `null` once the folio is cancelled — there is nothing left to quote.
export interface PosCancellationQuote {
  refund: number
  retention: number
  kept_commission: number
  reversed_commission: number
  /** US-AG54 — per-line ladder readings incl. the single-line SUBSET refund, server-computed. */
  lines?: Array<{
    line_id: string
    hours_out: number | null
    refund_pct: number
    retention: number
    redeemed: boolean
    line_refund?: number | null
    line_reversed_commission?: number | null
  }>
}

// US-AG08 / AG21 — read back one of the caller agent's own folios (receipt + history detail).
// Returns the quote alongside the folio so the cancel dialog can state the refund instead of
// asserting one (it used to say "el anticipo no es reembolsable" unconditionally, which stopped
// being true when apartados started following the ladder — engine D20).
export const getFolio = async (
  id: string,
): Promise<{ folio: Folio; quote: PosCancellationQuote | null; events: FolioEvent[] }> => {
  const res = await request<{
    folio: Folio
    cancellation_quote?: PosCancellationQuote | null
    // US-AG53 — the seller reads the SAME narrative the admin reads (timeline D6); absent
    // pre-timeline ⇒ none.
    events?: FolioEvent[]
  }>(`/api/pos/folios/${id}`)
  return { folio: res.folio, quote: res.cancellation_quote ?? null, events: res.events ?? [] }
}


export interface MyFolioFilters {
  status?: FolioStatus
  /** US-AG58 (D11) — the inclusive ORG-LOCAL range the admin list already takes. Replaces the
   *  dead `date` param, which compared a UTC calendar day. */
  from?: string
  to?: string
}

/** US-AG58 (D4/D5) — the seller's list is their WHOLE history, so the client can search and facet
 *  it locally and still answer about everything. `truncated` is the safety cap announcing itself:
 *  a cap that stays quiet reports "these are your sales" when it means "these are your 500 most
 *  recent". Same shape as the admin's `FolioListPage`; `window_days` is null because this read has
 *  no window to state. */
export interface MyFolioListPage {
  folios: FolioHistoryItem[]
  window_days: null
  truncated: boolean
}

// US-AG20 — the caller agent's own folio history. Server scopes to the caller (no agent_id).
export const listMyFolios = async (
  filters: MyFolioFilters = {},
): Promise<MyFolioListPage> => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  const qs = params.toString()
  const res = await request<{ folios: FolioHistoryItem[]; truncated?: boolean }>(
    `/api/pos/folios${qs ? `?${qs}` : ''}`,
  )
  return { folios: res.folios, window_days: null, truncated: res.truncated ?? false }
}
