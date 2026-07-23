import { request } from './authService'
import type {
  ApproveCancellationRequestInput,
  CancellationRequest,
  CancellationRequestStatus,
  ConfirmRefundInput,
  FolioDetail,
  FolioFilters,
  FolioListItem,
  RejectCancellationRequestInput,
} from '../features/folios/types'

// Admin folio management (US-A21): browse folios and cancel one in full. All calls require
// the admin role (enforced server-side). Money is integer minor units.

// US-A21 — list folios in the org (find one to cancel). Optional status/date/agent filters.
export const listFolios = async (filters: FolioFilters = {}): Promise<FolioListItem[]> => {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.date) params.set('date', filters.date)
  if (filters.agentId) params.set('agent_id', filters.agentId)
  if (filters.verification) params.set('verification', filters.verification)
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

// --- Tourist cancellation requests + refund tracking (US-T04/T05, US-A23) ---
// Spec: docs/tourist-portal/tourist-self-service-portal.spec.md

// US-T04 — the admin review queue. Defaults to the actionable `pending` set.
export const listCancellationRequests = async (
  status: CancellationRequestStatus | 'all' = 'pending',
): Promise<CancellationRequest[]> => {
  const res = await request<{ requests: CancellationRequest[] }>(
    `/api/folios/cancellation-requests?status=${status}`,
  )
  return res.requests
}

// US-T04 → US-A21 — approve: cancels the folio (seats released, client emailed) and, when
// it was paid, opens the refund obligation + issues the tourist's portal PIN.
export const approveCancellationRequest = async (
  requestId: string,
  input: ApproveCancellationRequestInput = {},
): Promise<{ request: CancellationRequest; folio: FolioDetail }> =>
  request<{ request: CancellationRequest; folio: FolioDetail }>(
    `/api/folios/cancellation-requests/${requestId}/approve`,
    { method: 'POST', body: JSON.stringify(input) },
  )

// US-T04 — reject with a required note (the tourist reads it in their portal). Folio untouched.
export const rejectCancellationRequest = async (
  requestId: string,
  input: RejectCancellationRequestInput,
): Promise<CancellationRequest> => {
  const res = await request<{ request: CancellationRequest }>(
    `/api/folios/cancellation-requests/${requestId}/reject`,
    { method: 'POST', body: JSON.stringify(input) },
  )
  return res.request
}

// US-A23 / US-T05 — confirm the physical cash refund: the tourist's PIN (primary) or an
// override note (lost-link escape hatch).
export const confirmRefund = async (
  folioId: string,
  input: ConfirmRefundInput,
): Promise<FolioDetail> => {
  const res = await request<{ folio: FolioDetail }>(
    `/api/folios/${folioId}/refund/confirm`,
    { method: 'POST', body: JSON.stringify(input) },
  )
  return res.folio
}
