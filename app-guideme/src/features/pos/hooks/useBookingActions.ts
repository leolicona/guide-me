import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  cancelBooking,
  claimReminder,
  reactivateBooking,
  settleBooking,
} from '../../../services/posService'
import { MY_FOLIOS_QUERY_KEY } from './useMyFolios'
import { FOLIO_QUERY_KEY } from './useFolio'
import { POS_QUERY_KEY } from './usePosServices'

// Any booking action changes a folio and (settle/cancel/reactivate) inventory, so invalidate
// the folio history, the open folio, and the catalog availability.
function useInvalidateBookings() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: MY_FOLIOS_QUERY_KEY })
    qc.invalidateQueries({ queryKey: FOLIO_QUERY_KEY })
    qc.invalidateQueries({ queryKey: POS_QUERY_KEY })
  }
}

// US-AG07 — one-shot settlement (collect the balance → paid + QR).
export function useSettleBooking() {
  const invalidate = useInvalidateBookings()
  return useMutation({ mutationFn: (id: string) => settleBooking(id), onSuccess: invalidate })
}

// US-AG07.4 — manual cancel (release spots; deposit retained).
export function useCancelBooking() {
  const invalidate = useInvalidateBookings()
  return useMutation({
    mutationFn: (v: { id: string; reason?: string }) => cancelBooking(v.id, v.reason),
    onSuccess: invalidate,
  })
}

// US-AG07.5 — reactivate an expired booking when capacity allows.
export function useReactivateBooking() {
  const invalidate = useInvalidateBookings()
  return useMutation({ mutationFn: (id: string) => reactivateBooking(id), onSuccess: invalidate })
}

// US-AG07.3 — claim the WhatsApp reminder (atomic; call BEFORE opening WhatsApp).
export function useClaimReminder() {
  const invalidate = useInvalidateBookings()
  return useMutation({
    mutationFn: (v: { id: string; force?: boolean }) => claimReminder(v.id, v.force),
    onSuccess: invalidate,
  })
}
