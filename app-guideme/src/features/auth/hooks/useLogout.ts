import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { logout } from '../../../services/authService'
import { useAuthStore } from '../../../store/authStore'
import { ROUTES } from '../../../config/routes'

export function useLogout() {
  const clear = useAuthStore((s) => s.clear)
  const navigate = useNavigate()
  const mutation = useMutation({ mutationFn: logout })

  const handleLogout = () => {
    clear()
    navigate(ROUTES.LOGIN, { replace: true })
    mutation.mutate()
  }

  return { logout: handleLogout, isPending: mutation.isPending }
}
