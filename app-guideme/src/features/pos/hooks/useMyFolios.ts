import { useQuery } from '@tanstack/react-query'
import { listMyFolios, type MyFolioFilters } from '../../../services/posService'

export const MY_FOLIOS_QUERY_KEY = ['pos', 'my-folios'] as const

// US-AG20 — the caller agent's own folio history (read-only list). The detail (US-AG21) is
// served by useFolio(id), which reuses GET /api/pos/folios/:id.
export function useMyFolios(filters: MyFolioFilters = {}) {
  return useQuery({
    queryKey: [...MY_FOLIOS_QUERY_KEY, filters],
    queryFn: () => listMyFolios(filters),
  })
}
