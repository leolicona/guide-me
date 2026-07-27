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
import type { CancellationQuote } from '../features/organization/types'

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

// US-A21 — one folio's detail (confirm before cancelling), plus what cancelling it right now
// would cost when the org has a cancellation policy (`cancellation_quote`, null otherwise).
export const getFolio = async (
  id: string,
): Promise<{ folio: FolioDetail; quote: CancellationQuote | null }> => {
  const res = await request<{
    folio: FolioDetail
    cancellation_quote?: CancellationQuote | null
  }>(`/api/folios/${id}`)
  return { folio: res.folio, quote: res.cancellation_quote ?? null }
}

export interface CancelFolioOptions {
  reason?: string
  // US-A26 — true → claw back the agent's commission; omitted/false → company absorbs it.
  // IGNORED by the server once the org has a policy: the ladder decides. The UI hides the control
  // in that case rather than sending a value that will not be honoured.
  clawback?: boolean
  // US-A71 — the COMPANY caused this cancellation (weather, a broken boat). Skips the ladder:
  // full refund, seller keeps their commission.
  cancelledByCompany?: boolean
}

// The realised numbers a policy-priced cancellation returns. Absent when the org has no policy —
// the response shape is unchanged for those orgs.
export interface CancellationOutcome {
  refund: number
  retention: number
  kept_commission: number
  reversed_commission: number
}

// US-A21 / US-A26 / US-A71 — cancel the whole folio: releases every line's spots, records the
// cancellation, and prices the refund from the org's ladder when one is configured.
export const cancelFolio = async (
  id: string,
  options: CancelFolioOptions = {},
): Promise<{ folio: FolioDetail; cancellation: CancellationOutcome | null }> => {
  const body: Record<string, unknown> = {}
  if (options.reason) body.reason = options.reason
  if (options.clawback) body.clawback = true
  if (options.cancelledByCompany) body.cancelled_by_company = true
  const res = await request<{
    folio: FolioDetail
    cancellation?: CancellationOutcome | null
  }>(`/api/folios/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return { folio: res.folio, cancellation: res.cancellation ?? null }
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
