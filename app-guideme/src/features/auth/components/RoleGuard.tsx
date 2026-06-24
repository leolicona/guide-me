import { type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useCurrentUser } from '../CurrentUserContext'
import { ROUTES } from '../../../config/routes'

type Role = 'admin' | 'agent' | 'affiliate'

interface RoleGuardProps {
  /** One role or a set — the guard passes when the caller's role is allowed. */
  role: Role | Role[]
  children: ReactNode
}

// US-UX01 — each role's landing (first daily action): admin → Hoy; agent + affiliate → Vender.
const landingFor = (role: Role) => (role === 'admin' ? ROUTES.DASHBOARD : ROUTES.POS)

// Composes inside AuthGuard, which guarantees the current user is available.
export function RoleGuard({ role, children }: RoleGuardProps) {
  const user = useCurrentUser()
  const allowed = Array.isArray(role) ? role : [role]

  if (!allowed.includes(user.role)) {
    // Bounce to the caller's OWN landing — never a fixed route, or guarding a role's landing
    // (e.g. admin-only /dashboard) would loop the other role back onto it.
    return <Navigate to={landingFor(user.role)} replace />
  }

  return <>{children}</>
}
