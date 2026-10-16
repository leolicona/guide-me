import { request } from './authService'
import type { DevoladaConnectionView } from '../features/devolada/types'

// devolada-transfer-verification — the organization's Devolada connection, admin only
// (contracts/turistear-api.md § Connection). The key travels once, on connect; every answer carries
// only its last four characters.

export const getDevoladaConnection = async (): Promise<DevoladaConnectionView | null> => {
  const res = await request<{ connection: DevoladaConnectionView | null }>('/api/organizations/me/devolada')
  return res.connection
}

export interface ConnectDevoladaInput {
  api_key: string
  /** FR-006 — take Devolada's one notification address from whatever system holds it now. */
  replace_webhook?: boolean
}

export const connectDevolada = async (input: ConnectDevoladaInput): Promise<DevoladaConnectionView> => {
  const res = await request<{ connection: DevoladaConnectionView }>('/api/organizations/me/devolada', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
  return res.connection
}

export const disconnectDevolada = async (): Promise<DevoladaConnectionView | null> => {
  const res = await request<{ connection: DevoladaConnectionView | null }>('/api/organizations/me/devolada', {
    method: 'DELETE',
  })
  return res.connection
}
