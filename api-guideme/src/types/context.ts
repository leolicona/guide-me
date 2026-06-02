export type UserRole = 'admin' | 'agent'

export interface UserPayload {
  userId: string
  email: string
  role: UserRole
  organizationId: string
}

export interface AppVariables {
  user: UserPayload
}
