import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deactivateSchedule } from '../../../services/schedulesService'
import { SLOTS_QUERY_KEY } from './useSlots'
import { SCHEDULES_QUERY_KEY } from './useSchedules'

export function useDeactivateSchedule(serviceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (scheduleId: string) =>
      deactivateSchedule(serviceId, scheduleId),
    onSuccess: () => {
      // Cascade-closes unbooked slots, so both lists go stale.
      queryClient.invalidateQueries({
        queryKey: [...SLOTS_QUERY_KEY, serviceId],
      })
      queryClient.invalidateQueries({
        queryKey: [...SCHEDULES_QUERY_KEY, serviceId],
      })
    },
  })
}
