import { useMutation, useQueryClient } from '@tanstack/react-query'
import { reactivateSlot } from '../../../services/schedulesService'
import { SLOTS_QUERY_KEY } from './useSlots'

export function useReactivateSlot(serviceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (slotId: string) => reactivateSlot(serviceId, slotId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [...SLOTS_QUERY_KEY, serviceId],
      }),
  })
}
