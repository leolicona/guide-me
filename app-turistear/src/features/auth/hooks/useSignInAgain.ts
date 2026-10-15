import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { authClient } from '../../../services/authClient'
import { ROUTES } from '../../../config/routes'
import { usePasskeyOffer } from '../../../store/passkeyOffer'
import { PASSKEYS_QUERY_KEY } from './usePasskeys'

/**
 * passkey-auth US2 (scenario 9), FR-005 — adding a llave de acceso needs a session less than a day
 * old (Better Auth's fresh-session rule). The way to get one is to sign in again: end the stale
 * session, then come back here through `?redirect=`.
 */
export function useSignInAgain() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const dismissOffer = usePasskeyOffer((s) => s.dismiss)

  return useMutation({
    mutationFn: async () => {
      // A failed sign-out still leaves the way forward open: a new sign-in replaces the cookie.
      await authClient.signOut()
    },
    onSettled: () => {
      dismissOffer()
      queryClient.removeQueries({ queryKey: ['me'] })
      queryClient.removeQueries({ queryKey: PASSKEYS_QUERY_KEY })
      const back = location.pathname + location.search
      navigate(`${ROUTES.LOGIN}?redirect=${encodeURIComponent(back)}`, { replace: true })
    },
  })
}
