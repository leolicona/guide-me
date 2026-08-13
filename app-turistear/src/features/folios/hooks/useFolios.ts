import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveCancellationRequest,
  cancelFolio,
  cancelFolioLine,
  confirmRefund,
  getFolio,
  getFolioCounts,
  listCancellationRequests,
  listFolios,
  rejectCancellationRequest,
} from '../../../services/foliosService'
import type {
  CancellationRequestStatus,
  ConfirmRefundInput,
  FolioFilters,
  RejectCancellationRequestInput,
} from '../types'

const FOLIOS_KEY = ['folios'] as const

// US-A21 — admin folio list (find one to cancel).
//
// US-A84 — ONE list read now serves the whole screen. The five queue hooks that used to sit beside
// it (`usePendingVerificationCount`, `usePendingDeliveryCount`, `usePendingRefundCount`,
// `useOverdueBookingCount`, `usePendingRefunds`, `useOverdueBookings`) are gone: each fetched a
// full filtered list — `usePendingDeliveryCount` pulled every paid folio WITH its lines and portal
// link — only to call `.length`. Their job is `useFolioCounts` below, in one aggregate.
// US-A83 — `enabled` exists for the search fallback: the second read only fires when the local pass
// found nothing, so the common case still costs exactly one request.
export const useFolios = (filters: FolioFilters = {}, enabled = true) =>
  useQuery({
    queryKey: [...FOLIOS_KEY, filters],
    queryFn: () => listFolios(filters),
    enabled,
  })

// US-A84 (D7/D20) — the pending-work counts. Shared by the list's banner and `Hoy`'s pills, which
// is what makes the two surfaces structurally incapable of showing different numbers. They read the
// WHOLE organization, never the loaded window, so a count always matches the list its pill opens.
// `refetchInterval` exists for Hoy's polling convention (occupancy-dashboard.spec.md D3).
export const useFolioCounts = (enabled = true, refetchInterval?: number) =>
  useQuery({
    queryKey: [...FOLIOS_KEY, 'counts'] as const,
    queryFn: getFolioCounts,
    enabled,
    refetchInterval,
  })

// US-A21 — one folio's detail.
export const useFolio = (id: string | undefined) =>
  useQuery({
    queryKey: [...FOLIOS_KEY, id],
    queryFn: () => getFolio(id as string),
    enabled: !!id,
  })

// US-A21 — cancel the whole folio; refresh both the list and the open detail. The refund is priced
// by the org's ladder (D10): there is nothing for the caller to decide beyond an optional note.
export const useCancelFolio = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => cancelFolio(id, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: FOLIOS_KEY }),
  })
}

// US-A22 (line-autonomy F2) — cancel ONE line; same refresh, same ladder-decides contract.
export const useCancelFolioLine = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, lineId, reason }: { id: string; lineId: string; reason?: string }) =>
      cancelFolioLine(id, lineId, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: FOLIOS_KEY }),
  })
}

// --- Tourist cancellation requests + refund tracking (US-T04/T05, US-A23) ---

const REQUESTS_KEY = [...FOLIOS_KEY, 'requests'] as const

// US-T04 — the admin review queue (defaults to pending).
//
// US-A84 — no surface lists requests any more; this stays because the approve/reject mutations
// invalidate it and because a folio's own history now arrives on its detail (rule 7).
export const useCancellationRequests = (
  status: CancellationRequestStatus | 'all' = 'pending',
) =>
  useQuery({
    queryKey: [...REQUESTS_KEY, status],
    queryFn: () => listCancellationRequests(status),
  })

// US-T04 → US-A21 — approve a request: cancels the folio + opens the refund (PIN issued
// server-side for the tourist's portal). Refreshes folios + the queue together.
export const useApproveCancellationRequest = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => approveCancellationRequest(id),
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
