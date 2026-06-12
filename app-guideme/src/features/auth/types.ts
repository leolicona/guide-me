export interface UserPayload {
  userId: string
  name: string
  email: string
  role: 'admin' | 'agent'
  organizationId: string
}
