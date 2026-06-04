import { useQuery } from '@tanstack/react-query'
import { listSlots } from '../../../services/schedulesService'
import type { SlotListFilters } from '../../../services/schedulesService'

export const SLOTS_QUERY_KEY = ['slots'] as const

export function useSlots(
  serviceId: string | undefined,
  filters?: SlotListFilters,
) {
  return useQuery({
    queryKey: [...SLOTS_QUERY_KEY, serviceId, filters ?? {}],
    queryFn: () => listSlots(serviceId as string, filters),
    enabled: !!serviceId,
  })
}
