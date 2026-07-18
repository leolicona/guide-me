import { useQuery } from '@tanstack/react-query'
import { verifyEmail } from '../../../services/authService'

export function useVerify(token: string | null) {
  return useQuery({
    queryKey: ['verify', token],
    queryFn: () => verifyEmail(token!),
    enabled: !!token,
    retry: false,
    // BUG-010 — the token is SINGLE-USE: any refetch re-submits an already-consumed
    // token and flips a delivered success into "Verificación fallida". Run exactly once.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}
