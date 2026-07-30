import { useQuery } from '@tanstack/react-query'
import { getFolio } from '../../../services/posService'

export const FOLIO_QUERY_KEY = ['pos', 'folio'] as const

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

export function useFolio(id: string | undefined) {
  return useQuery({
    ...folioQuery(id),
    select: (r: Awaited<ReturnType<typeof getFolio>>) => r.folio,
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
