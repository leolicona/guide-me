import { type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useCurrentUser } from '../CurrentUserContext'
import { ROUTES } from '../../../config/routes'

interface RoleGuardProps {
  role: 'admin' | 'agent'
  children: ReactNode
}

// Composes inside AuthGuard, which guarantees the current user is available.
export function RoleGuard({ role, children }: RoleGuardProps) {
  const user = useCurrentUser()

  if (user.role !== role) {
    return <Navigate to={ROUTES.DASHBOARD} replace />
  }

  return <>{children}</>
}
