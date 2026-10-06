// The product knows two roles (retire-affiliates); delete-legacy-affiliates D1 removed the last
// user row stored with another.
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
