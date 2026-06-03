import { useMutation } from '@tanstack/react-query'
import { inviteAgent } from '../../../services/agentsService'

export function useInviteAgent() {
  return useMutation({
    mutationFn: inviteAgent,
  })
}
