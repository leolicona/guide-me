import { useMutation } from '@tanstack/react-query'
import { completeInvite, type CompleteInviteInput } from '../../../services/authService'

export function useInviteComplete() {
  return useMutation({
    mutationFn: (data: CompleteInviteInput) => completeInvite(data),
  })
}
