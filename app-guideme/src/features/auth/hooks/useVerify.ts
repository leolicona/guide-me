import { useQuery } from '@tanstack/react-query'
import { verifyEmail } from '../../../services/authService'

export function useVerify(token: string | null) {
  return useQuery({
    queryKey: ['verify', token],
    queryFn: () => verifyEmail(token!),
    enabled: !!token,
    retry: false,
  })
}
