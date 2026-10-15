import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { authClient } from '../../../services/authClient'
import { ROUTES } from '../../../config/routes'
import { toAuthError } from '../authErrors'
import { PASSKEYS_QUERY_KEY } from './usePasskeys'

// passkey-auth US1 (scenario 8), FR-023 — Better Auth deletes the session row and expires the
// cookie, so the same cookie can never be replayed.
async function signOut(): Promise<void> {
  const { error } = await authClient.signOut()
  if (error) throw toAuthError(error)
}

export function useLogout() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const mutation = useMutation({ mutationFn: signOut })

  const handleLogout = async () => {
    // AWAIT the server before navigating (BUG-006): the cookie is httpOnly, so this POST is the
    // only thing that actually ends the session. Fire-and-forget showed "logged out" while a
    // failed request silently left the session alive. Awaiting also closes BUG-003's residual
    // race (back-press before the cookie cleared). On failure we stay put and surface isError —
    // the caller offers a retry.
    try {
      await mutation.mutateAsync()
    } catch {
      return
    }
    // Evict the ['me'] cache so a back-button nav can't re-render AuthGuard from a
    // stale-but-"fresh" cached user (useMe has a 5-min staleTime). Without this,
    // popstate restores the in-memory cache, no /api/me call fires, and the 401
    // interceptor never runs — leaving the app reachable after logout (BUG-003).
    queryClient.removeQueries({ queryKey: ['me'] })
    // The next person on this phone must not glimpse this account's llaves de acceso.
    queryClient.removeQueries({ queryKey: PASSKEYS_QUERY_KEY })
    navigate(ROUTES.LOGIN, { replace: true })
  }

  return { logout: handleLogout, isPending: mutation.isPending, isError: mutation.isError }
}
