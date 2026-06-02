export interface UserPayload {
  name: string
  email: string
  role: 'admin' | 'agent'
  organizationId: string
}
