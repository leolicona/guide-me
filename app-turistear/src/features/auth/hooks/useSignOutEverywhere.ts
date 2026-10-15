import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { authClient } from '../../../services/authClient'
import { ROUTES } from '../../../config/routes'
import { toAuthError } from '../authErrors'
import { PASSKEYS_QUERY_KEY } from './usePasskeys'

/**
 * passkey-auth US5 (scenario 4), FR-024 — Better Auth deletes every session of the user, this one
 * included; each device is refused at its next request. This device goes straight to sign-in.
 */
export function useSignOutEverywhere() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  return useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeSessions()
      if (error) throw toAuthError(error)
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['me'] })
      queryClient.removeQueries({ queryKey: PASSKEYS_QUERY_KEY })
      navigate(ROUTES.LOGIN, { replace: true })
    },
  })
}
