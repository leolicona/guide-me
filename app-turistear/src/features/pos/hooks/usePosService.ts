import { useQuery } from '@tanstack/react-query'
import { getPosService } from '../../../services/posService'
import type { ServiceDetailRange } from '../../../services/posService'

export const POS_SERVICE_QUERY_KEY = ['pos', 'service'] as const

// US-AG57 — the sale sheet re-reads this per SELECTED DAY, so the range is part of the key and
// every date change is a fresh query. Without `placeholderData` that means `isLoading` flips true,
// the owner's `{service && …}` gate drops the panel, and the Bottom Sheet collapses to a spinner
// and springs back — reading as the sheet closing and reopening under the thumb. Holding the
// previous day's payload keeps the panel mounted and the sheet's height stable; `isFetching`
// carries the "this day is loading" signal instead, and the slot chips alone show a skeleton.
//
// Scoped to the SAME service on purpose: `prev` is the last resolved query on this hook whatever
// its key, so opening a different card would otherwise flash the previous service's name, price
// and departures before its own arrived — a worse lie than a spinner.
export function usePosService(
  id: string | undefined,
  range?: ServiceDetailRange,
) {
  return useQuery({
    queryKey: [...POS_SERVICE_QUERY_KEY, id, range ?? {}],
    queryFn: () => getPosService(id as string, range),
    enabled: !!id,
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === id ? prev : undefined,
  })
}
