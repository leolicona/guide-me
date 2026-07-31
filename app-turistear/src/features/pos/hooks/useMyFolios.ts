import { useQuery } from '@tanstack/react-query'
import { listMyFolios, type MyFolioFilters } from '../../../services/posService'
import { deliveryState } from '../delivery'

export const MY_FOLIOS_QUERY_KEY = ['pos', 'my-folios'] as const

// US-AG20 — the caller agent's own folio history (read-only list). The detail (US-AG21) is
// served by useFolio(id), which reuses GET /api/pos/folios/:id.
export function useMyFolios(filters: MyFolioFilters = {}) {
  return useQuery({
    queryKey: [...MY_FOLIOS_QUERY_KEY, filters],
    queryFn: () => listMyFolios(filters),
  })
}

// US-A80 (express-sale D23) — the seller's own pending-delivery count, surfaced on the Ventas
// nav badge. Shares the paid-list cache with the history page; a folio leaves the count the
// moment the tourist's camera-scan fires the /t beacon or the seller taps WhatsApp.
export function usePendingDeliveryCount(enabled: boolean) {
  return useQuery({
    queryKey: [...MY_FOLIOS_QUERY_KEY, { status: 'paid' }],
    queryFn: () => listMyFolios({ status: 'paid' }),
    enabled,
    select: (folios) => folios.filter((f) => deliveryState(f) === 'pending').length,
  })
}
