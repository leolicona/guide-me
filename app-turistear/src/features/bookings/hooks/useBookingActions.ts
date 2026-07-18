import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  cancelBooking,
  claimReminder,
  reactivateBooking,
  settleBooking,
} from '../../../services/bookingsService'

// A booking action mutates a folio and (settle/cancel/reactivate) inventory, so every dependent
// query must refetch. We invalidate the two folio NAMESPACES by their root keys (TanStack matches
// by prefix): `['pos']` covers the catalog availability + the agent folio list/detail; `['folios']`
// covers the admin list/detail. Using the literal roots keeps `features/bookings` free of any
// import into `pos`/`folios` — so both features depend on bookings, never the reverse.
function useInvalidateBookings() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['pos'] })
    qc.invalidateQueries({ queryKey: ['folios'] })
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
