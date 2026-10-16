import { useQuery } from '@tanstack/react-query'
import { getFolio } from '../../../services/posService'
import type { PaymentLinkLabel } from '../../devolada/types'

export const FOLIO_QUERY_KEY = ['pos', 'folio'] as const

// devolada-transfer-verification D16 — the labels of an enlace still in flight: waiting for the
// customer's transfer, or for Banxico's answer to it. Its verdict reaches the server by webhook or
// by the sweep, never through a mutation this screen could invalidate on, so the receipt re-reads
// the sale until the label leaves this set.
const LINK_IN_FLIGHT: ReadonlySet<PaymentLinkLabel> = new Set<PaymentLinkLabel>([
  'awaiting_payment',
  'validating',
  'needs_tracking_key',
  'credit_paused',
])
const LINK_POLL_MS = 15_000

// One request serves both hooks below — same key, different `select`.
//
// `staleTime` is no longer Infinity. It used to be, on the reasoning that a folio is immutable once
// created; that was already only half true (settle, cancel and the reminder claim all mutate it,
// though each invalidates this key), and it stopped being true at all once the response started
// carrying a CANCELLATION QUOTE. A quote is a function of the clock — it steps down as the
// departure approaches, with no mutation to invalidate on — so caching it forever would let an
// agent confirm a cancellation against a figure from a tier that no longer applies. A minute is
// short enough that only an exact tier boundary could fall inside it, and long enough that opening
// a receipt does not refetch on every render.
const folioQuery = (id: string | undefined) => ({
  queryKey: [...FOLIO_QUERY_KEY, id],
  queryFn: () => getFolio(id as string),
  enabled: !!id,
  staleTime: 60_000,
})

// US-A93 (folio-surface-parity D1) — the WHOLE detail read, in the shape the admin's `useFolio`
// returns (`{ folio, quote, events }`), so one screen can take either without branching on the
// surface to read its own data. The three selecting hooks below stay for the POS screens that want
// one slice; all four share the single request above.
export function useFolioDetailRead(id: string | undefined) {
  return useQuery(folioQuery(id))
}

// The receipt's read. Only this observer polls (D16): the hooks sharing its key keep their
// behaviour, and its interval refetches the one request they all share. The callback sees the
// un-selected read, whose latest enlace comes first (`payment_links` is newest first).
export function useFolio(id: string | undefined) {
  return useQuery({
    ...folioQuery(id),
    select: (r: Awaited<ReturnType<typeof getFolio>>) => r.folio,
    refetchInterval: (query) => {
      const label = query.state.data?.folio.payment_links?.[0]?.label
      return label && LINK_IN_FLIGHT.has(label) ? LINK_POLL_MS : false
    },
  })
}

// What cancelling this folio right now would cost (US-A76). `null` when the folio is already
// cancelled. Kept as its own hook so a screen that only renders the folio does not have to know
// the quote exists.
export function useFolioCancellationQuote(id: string | undefined) {
  return useQuery({
    ...folioQuery(id),
    select: (r: Awaited<ReturnType<typeof getFolio>>) => r.quote,
  })
}

// US-AG53 — the folio's narrative, riding the same detail read (timeline D5/D6). A cache entry
// written before the timeline shipped has no `events`; missing ⇒ [].
export function useFolioEvents(id: string | undefined) {
  return useQuery({
    ...folioQuery(id),
    select: (r: Awaited<ReturnType<typeof getFolio>>) => r.events ?? [],
  })
}
