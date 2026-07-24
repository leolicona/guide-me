import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveCancellationRequest,
  cancelFolio,
  confirmRefund,
  getFolio,
  listCancellationRequests,
  listFolios,
  rejectCancellationRequest,
} from '../../../services/foliosService'
import type {
  ApproveCancellationRequestInput,
  CancellationRequestStatus,
  ConfirmRefundInput,
  FolioFilters,
  RejectCancellationRequestInput,
} from '../types'

const FOLIOS_KEY = ['folios'] as const

// US-A21 — admin folio list (find one to cancel).
export const useFolios = (filters: FolioFilters = {}) =>
  useQuery({
    queryKey: [...FOLIOS_KEY, filters],
    queryFn: () => listFolios(filters),
  })

// US-A67 — the admin "Por verificar" queue: electronic payments awaiting verification.
export const usePendingVerificationFolios = () =>
  useFolios({ verification: 'pending' })

// US-A67 — badge feed for the Folios nav (admins only — pass `enabled`). Shares the pending-queue
// cache with the "Por verificar" tab, so it adds no extra request when both mount.
export const usePendingVerificationCount = (enabled: boolean) =>
  useQuery({
    queryKey: [...FOLIOS_KEY, { verification: 'pending' }] as const,
    queryFn: () => listFolios({ verification: 'pending' }),
    enabled,
    select: (folios) => folios.length,
  })

// US-A21 — one folio's detail.
export const useFolio = (id: string | undefined) =>
  useQuery({
    queryKey: [...FOLIOS_KEY, id],
    queryFn: () => getFolio(id as string),
    enabled: !!id,
  })

// US-A21 / US-A26 — cancel the whole folio (optionally clawing back the agent's commission);
// refresh both the list and the open detail.
export const useCancelFolio = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      reason,
      clawback,
    }: {
      id: string
      reason?: string
      clawback?: boolean
    }) => cancelFolio(id, { reason, clawback }),
    onSuccess: () => qc.invalidateQueries({ queryKey: FOLIOS_KEY }),
  })
}

// --- Tourist cancellation requests + refund tracking (US-T04/T05, US-A23) ---

const REQUESTS_KEY = [...FOLIOS_KEY, 'cancellation-requests'] as const

// US-T04 — the admin review queue (defaults to pending).
export const useCancellationRequests = (
  status: CancellationRequestStatus | 'all' = 'pending',
) =>
  useQuery({
    queryKey: [...REQUESTS_KEY, status],
    queryFn: () => listCancellationRequests(status),
  })

// Badge feed for the Folios nav destination (admins only — pass `enabled`). Shares the
// pending-queue cache with FoliosListPage, so it adds no extra request when both mount.
export const usePendingCancellationCount = (enabled: boolean) =>
  useQuery({
    queryKey: [...REQUESTS_KEY, 'pending'] as const,
    queryFn: () => listCancellationRequests('pending'),
    enabled,
    select: (requests) => requests.length,
  })

// US-T04 → US-A21 — approve a request: cancels the folio + opens the refund (PIN issued
// server-side for the tourist's portal). Refreshes folios + the queue together.
export const useApproveCancellationRequest = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string
      input?: ApproveCancellationRequestInput
    }) => approveCancellationRequest(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: FOLIOS_KEY }),
  })
}

// US-T04 — reject a request with a required note; the folio is untouched.
export const useRejectCancellationRequest = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RejectCancellationRequestInput }) =>
      rejectCancellationRequest(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: FOLIOS_KEY }),
  })
}

// US-A23 / US-T05 — confirm the physical cash refund (PIN or override note).
export const useConfirmRefund = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ConfirmRefundInput }) =>
      confirmRefund(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: FOLIOS_KEY }),
  })
}
