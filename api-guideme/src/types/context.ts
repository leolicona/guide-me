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
