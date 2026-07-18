import { useQuery } from '@tanstack/react-query'
import { getInvite } from '../../../services/authService'

export function useInviteAccept(token: string | null) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => getInvite(token!),
    enabled: !!token,
    retry: false,
  })
}
