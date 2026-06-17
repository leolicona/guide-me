import { useQuery } from '@tanstack/react-query'
import { getMyOrganization } from '../../../services/organizationsService'

export const MY_ORG_QUERY_KEY = ['organization', 'me'] as const

// The caller's organization + booking policy (US-A46). Cached a few minutes — policy rarely
// changes within a selling session, and the deposit chip only needs the minimum %.
export function useMyOrganization() {
  return useQuery({
    queryKey: MY_ORG_QUERY_KEY,
    queryFn: getMyOrganization,
    staleTime: 5 * 60 * 1000,
  })
}
