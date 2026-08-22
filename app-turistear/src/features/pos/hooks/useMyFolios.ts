import { useQuery } from '@tanstack/react-query'
import { listMyFolios, type MyFolioFilters } from '../../../services/posService'
import { deliveryState } from '../delivery'

export const MY_FOLIOS_QUERY_KEY = ['pos', 'my-folios'] as const

// US-AG20 — the caller agent's own folio history (read-only list). The detail (US-AG21) is
// served by useFolio(id), which reuses GET /api/pos/folios/:id.
export function useMyFolios(filters: MyFolioFilters = {}, enabled = true) {
  return useQuery({
    queryKey: [...MY_FOLIOS_QUERY_KEY, filters],
    queryFn: () => listMyFolios(filters),
    enabled,
  })
}

// US-A80 (express-sale D23) — the seller's own pending-delivery count, surfaced on the Ventas
// nav badge. Shares the paid-list cache with the history page; a folio leaves the count the
// moment the tourist's camera-scan fires the /t beacon or the seller taps WhatsApp.
// US-AG58 (D12) — keyed on `{}`, the same entry the list itself reads: since the list is now an
// unfiltered read of the seller's whole history, the badge and the screen are literally the same
// request, and the badge stopped firing a second one.
export function usePendingDeliveryCount(enabled: boolean) {
  return useQuery({
    queryKey: [...MY_FOLIOS_QUERY_KEY, {}],
    queryFn: () => listMyFolios({}),
    enabled,
    select: (page) => page.folios.filter((f) => deliveryState(f) === 'pending').length,
  })
}
