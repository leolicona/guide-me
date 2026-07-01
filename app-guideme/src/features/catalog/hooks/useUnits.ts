import { useQuery } from '@tanstack/react-query'
import { listUnits } from '../../../services/lodgingCatalogService'

export const unitsQueryKey = (serviceId: string) => ['units', serviceId] as const

// US-A59 — units under a lodging service. Enabled only for a real service id.
export function useUnits(serviceId: string, enabled = true) {
  return useQuery({
    queryKey: unitsQueryKey(serviceId),
    queryFn: () => listUnits(serviceId),
    enabled: enabled && !!serviceId,
  })
}
