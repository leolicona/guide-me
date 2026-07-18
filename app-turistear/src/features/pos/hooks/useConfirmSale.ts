import { useMutation, useQueryClient } from '@tanstack/react-query'
import { confirmSale } from '../../../services/posService'
import type { ConfirmSaleInput } from '../../../services/posService'
import { POS_QUERY_KEY } from './usePosServices'

// Confirms the cart. On success the availability queries are invalidated (a sale
// changed remaining counts). Cart-clearing + navigation to the receipt are the
// page's concern, so the hook stays reusable.
export function useConfirmSale() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: ConfirmSaleInput) => confirmSale(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: POS_QUERY_KEY }),
  })
}
