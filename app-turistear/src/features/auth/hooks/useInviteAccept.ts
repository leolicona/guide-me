import { useQuery } from '@tanstack/react-query'
import { getInvitation } from '../../../services/authService'

// passkey-auth US4 — the invitation lookup (organization name and invited address).
export function useInviteAccept(token: string | null) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => getInvitation(token!),
    enabled: !!token,
    retry: false,
  })
}
