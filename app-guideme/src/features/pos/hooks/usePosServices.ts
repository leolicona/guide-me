import { useQuery } from '@tanstack/react-query'
import { listPosServices } from '../../../services/posService'

export const POS_QUERY_KEY = ['pos'] as const
export const POS_SERVICES_QUERY_KEY = ['pos', 'services'] as const

// Availability is live: React Query's default staleTime (0) refetches on mount /
// window focus, so the agent sees fresh remaining counts without extra config.
export function usePosServices(today?: string) {
  return useQuery({
    queryKey: [...POS_SERVICES_QUERY_KEY, today ?? null],
    queryFn: () => listPosServices(today),
  })
}
