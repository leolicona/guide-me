import { request } from './authService'
import type { FolioDetail, FolioFilters, FolioListItem } from '../features/folios/types'

// Admin folio management (US-A21): browse folios and cancel one in full. All calls require
// the admin role (enforced server-side). Money is integer minor units.

// US-A21 — list folios in the org (find one to cancel). Optional status/date/agent filters.
export const listFolios = async (filters: FolioFilters = {}): Promise<FolioListItem[]> => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.date) params.set('date', filters.date)
  if (filters.agentId) params.set('agent_id', filters.agentId)
  const qs = params.toString()
  const res = await request<{ folios: FolioListItem[] }>(`/api/folios${qs ? `?${qs}` : ''}`)
  return res.folios
}

// US-A21 — one folio's detail (confirm before cancelling).
export const getFolio = async (id: string): Promise<FolioDetail> => {
  const res = await request<{ folio: FolioDetail }>(`/api/folios/${id}`)
  return res.folio
}

export interface CancelFolioOptions {
  reason?: string
  // US-A26 — true → claw back the agent's commission; omitted/false → company absorbs it.
  clawback?: boolean
}

// US-A21 / US-A26 — cancel the whole folio: releases every line's spots, records the
// cancellation, and flags whether the agent's commission is clawed back.
export const cancelFolio = async (
  id: string,
  options: CancelFolioOptions = {},
): Promise<FolioDetail> => {
  const body: Record<string, unknown> = {}
  if (options.reason) body.reason = options.reason
  if (options.clawback) body.clawback = true
  const res = await request<{ folio: FolioDetail }>(`/api/folios/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return res.folio
}
