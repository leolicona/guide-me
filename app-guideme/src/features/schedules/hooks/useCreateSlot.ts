import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createSlot } from '../../../services/schedulesService'
import type { SlotInput } from '../../../services/schedulesService'
import { SLOTS_QUERY_KEY } from './useSlots'

export function useCreateSlot(serviceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: SlotInput) => createSlot(serviceId, data),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [...SLOTS_QUERY_KEY, serviceId],
      }),
  })
}
