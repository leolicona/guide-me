import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { logout } from '../../../services/authService'
import { ROUTES } from '../../../config/routes'

export function useLogout() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const mutation = useMutation({ mutationFn: logout })

  const handleLogout = () => {
    // Evict the ['me'] cache so a back-button nav can't re-render AuthGuard from a
    // stale-but-"fresh" cached user (useMe has a 5-min staleTime). Without this,
    // popstate restores the in-memory cache, no /api/me call fires, and the 401
    // interceptor never runs — leaving the app reachable after logout (BUG-003).
    queryClient.removeQueries({ queryKey: ['me'] })
    navigate(ROUTES.LOGIN, { replace: true })
    mutation.mutate()
  }

  return { logout: handleLogout, isPending: mutation.isPending }
}
