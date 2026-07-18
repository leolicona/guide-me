export type AgentStatus = 'active' | 'suspended'

// No commission field (rev. 2026-06-11): commission is service-based — defined on the catalog
// service, not the agent (docs/commissions/service-based-commission.spec.md).
export interface Agent {
  id: string
  name: string
  email: string
  phone: string | null
  status: AgentStatus
}
