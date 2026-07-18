import { request } from './authService'
import type { Agent, AgentStatus } from '../features/agents/types'

export interface InviteAgentInput {
  identity: string
}

export interface InviteAgentResponse {
  message: string
}

export const inviteAgent = (data: InviteAgentInput) =>
  request<InviteAgentResponse>('/api/agents/invite', {
    method: 'POST',
    body: JSON.stringify(data),
  })

// US-A06 — list agents in the caller's organization.
export const listAgents = async (): Promise<Agent[]> => {
  const res = await request<{ agents: Agent[] }>('/api/agents')
  return res.agents
}

// US-A07 — edit an agent's profile (name, phone). No commission field (rev. 2026-06-11):
// commission is service-based — docs/commissions/service-based-commission.spec.md.
export interface UpdateAgentInput {
  name: string
  phone: string | null
}

export const updateAgent = async (
  id: string,
  data: UpdateAgentInput,
): Promise<Agent> => {
  const res = await request<{ agent: Agent }>(`/api/agents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
  return res.agent
}

// US-A08 — deactivate (suspend) / reactivate an agent.
interface AgentStatusResponse {
  agent: { id: string; name: string; status: AgentStatus }
}

export const deactivateAgent = (id: string) =>
  request<AgentStatusResponse>(`/api/agents/${id}/deactivate`, {
    method: 'POST',
  })

export const reactivateAgent = (id: string) =>
  request<AgentStatusResponse>(`/api/agents/${id}/reactivate`, {
    method: 'POST',
  })
