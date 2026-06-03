import { type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../../../store/authStore'
import { ROUTES } from '../../../config/routes'

interface RoleGuardProps {
  role: 'admin' | 'agent'
  children: ReactNode
}

// Composes inside AuthGuard, which guarantees authStore.user is populated.
export function RoleGuard({ role, children }: RoleGuardProps) {
  const user = useAuthStore((state) => state.user)

  if (!user || user.role !== role) {
    return <Navigate to={ROUTES.DASHBOARD} replace />
  }

  return <>{children}</>
}
