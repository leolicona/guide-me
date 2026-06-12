import { type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useCurrentUser } from '../CurrentUserContext'
import { ROUTES } from '../../../config/routes'

interface RoleGuardProps {
  role: 'admin' | 'agent'
  children: ReactNode
}

// US-UX01 — each role's landing (first daily action): admin → Hoy, agent → Vender.
const landingFor = (role: 'admin' | 'agent') =>
  role === 'admin' ? ROUTES.DASHBOARD : ROUTES.POS

// Composes inside AuthGuard, which guarantees the current user is available.
export function RoleGuard({ role, children }: RoleGuardProps) {
  const user = useCurrentUser()

  if (user.role !== role) {
    // Bounce to the caller's OWN landing — never a fixed route, or guarding a role's landing
    // (e.g. admin-only /dashboard) would loop the other role back onto it.
    return <Navigate to={landingFor(user.role)} replace />
  }

  return <>{children}</>
}
