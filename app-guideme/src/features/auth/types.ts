export type UserRole = 'admin' | 'agent' | 'affiliate'

export interface UserPayload {
  userId: string
  name: string
  email: string
  role: UserRole
  organizationId: string
  // Set only for an `affiliate` user; null for admin/agent.
  affiliateCompanyId?: string | null
}
