import { request } from './authService'

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
