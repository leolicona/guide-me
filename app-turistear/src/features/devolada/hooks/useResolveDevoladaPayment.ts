import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ServiceError } from '../../../services/authService'
import {
  resolveDevoladaPayment,
  type ResolveDevoladaAction,
} from '../../../services/devoladaService'

export interface ResolveDevoladaPaymentVariables {
  /** `PaymentLinkView.payment.id`. */
  paymentId: string
  action: ResolveDevoladaAction
  note?: string
}

// devolada-transfer-verification D15 — the admin's decision on a Devolada payment: «Verificar»
// (accept), «Descartar» (dismiss) or «Ya lo devolví» (returned). A decision changes the sale's money,
// its place in «Por verificar» and the counts, so both folio namespaces refetch by their root keys,
// as every booking action does (`features/bookings/hooks/useBookingActions.ts`): `['folios']` covers
// the admin list, its counts (the badge, the Ventas bar, Hoy) and the detail; `['pos']` covers the
// seller's list and detail.
//
// A 409 means the screen was stale — someone else decided the payment, or the sale changed under
// it — so it refetches too: the sheet says why it failed, and the sale behind it shows what holds now.
export function useResolveDevoladaPayment() {
  const queryClient = useQueryClient()
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['folios'] }),
      queryClient.invalidateQueries({ queryKey: ['pos'] }),
    ])
  return useMutation({
    mutationFn: ({ paymentId, action, note }: ResolveDevoladaPaymentVariables) =>
      resolveDevoladaPayment(paymentId, note ? { action, note } : { action }),
    onSuccess: refresh,
    onError: (error) => {
      if (error instanceof ServiceError && error.status === 409) void refresh()
    },
  })
}
