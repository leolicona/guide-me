export type UserRole = 'admin' | 'agent' | 'affiliate'

export interface UserPayload {
  userId: string
  name: string
  email: string
  role: UserRole
  organizationId: string
  // Set only for an `affiliate` user (their partner company); null for admin/agent. The portal
  // catalog filter + commission resolution key on it (affiliate-portal.spec.md §4.2).
  affiliateCompanyId: string | null
}

export interface AppVariables {
  user: UserPayload
}
