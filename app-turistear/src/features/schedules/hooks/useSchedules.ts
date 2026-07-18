import { useQuery } from '@tanstack/react-query'
import { listSchedules } from '../../../services/schedulesService'
import type { SlotStatus } from '../types'

export const SCHEDULES_QUERY_KEY = ['schedules'] as const

export function useSchedules(
  serviceId: string | undefined,
  status?: SlotStatus,
) {
  return useQuery({
    queryKey: [...SCHEDULES_QUERY_KEY, serviceId, status],
    queryFn: () => listSchedules(serviceId as string, status),
    enabled: !!serviceId,
  })
}
