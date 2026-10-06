// retire-affiliates D3 — the product knows two roles. A user row still stored as `affiliate` is
// refused by authMiddleware before any handler sees it.
export type UserRole = 'admin' | 'agent'

export interface UserPayload {
  userId: string
  name: string
  email: string
  role: UserRole
  organizationId: string
}

export interface AppVariables {
  user: UserPayload
}
