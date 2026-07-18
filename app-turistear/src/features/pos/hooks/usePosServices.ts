import { useQuery } from '@tanstack/react-query'
import { listPosServices } from '../../../services/posService'

export const POS_QUERY_KEY = ['pos'] as const
export const POS_SERVICES_QUERY_KEY = ['pos', 'services'] as const

// Availability is live: React Query's default staleTime (0) refetches on mount /
// window focus, so the agent sees fresh availability without extra config. US-AG35 —
// `from`/`to` key the query so changing the Date filter refetches the windowed flag.
export function usePosServices(today?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: [...POS_SERVICES_QUERY_KEY, today ?? null, from ?? null, to ?? null],
    queryFn: () => listPosServices(today, from, to),
  })
}
