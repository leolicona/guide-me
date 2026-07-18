import { useQuery } from '@tanstack/react-query'
import { getMe } from '../../../services/authService'

// The session source of truth. AuthGuard owns the gating/redirect logic and
// publishes the resolved user via CurrentUserContext, so this hook stays a thin,
// effect-free wrapper around the ['me'] query.
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
