import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateSlot } from '../../../services/schedulesService'
import type { UpdateSlotInput } from '../../../services/schedulesService'
import { SLOTS_QUERY_KEY } from './useSlots'

export function useUpdateSlot(serviceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      slotId,
      data,
    }: {
      slotId: string
      data: UpdateSlotInput
    }) => updateSlot(serviceId, slotId, data),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [...SLOTS_QUERY_KEY, serviceId],
      }),
  })
}
