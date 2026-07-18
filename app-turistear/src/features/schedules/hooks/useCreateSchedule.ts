import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createSchedule } from '../../../services/schedulesService'
import type { ScheduleInput } from '../../../services/schedulesService'
import { SLOTS_QUERY_KEY } from './useSlots'
import { SCHEDULES_QUERY_KEY } from './useSchedules'

export function useCreateSchedule(serviceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: ScheduleInput) => createSchedule(serviceId, data),
    onSuccess: () => {
      // Materialization creates slots, so both lists go stale.
      queryClient.invalidateQueries({
        queryKey: [...SLOTS_QUERY_KEY, serviceId],
      })
      queryClient.invalidateQueries({
        queryKey: [...SCHEDULES_QUERY_KEY, serviceId],
      })
    },
  })
}
