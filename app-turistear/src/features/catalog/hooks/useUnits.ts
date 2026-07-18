import { useQuery } from '@tanstack/react-query'
import { listUnitTypes } from '../../../services/lodgingCatalogService'

export const unitsQueryKey = (serviceId: string) => ['unit-types', serviceId] as const

// US-A59 (v2) — unit types under a lodging service. Enabled only for a real service id.
export function useUnits(serviceId: string, enabled = true) {
  return useQuery({
    queryKey: unitsQueryKey(serviceId),
    queryFn: () => listUnitTypes(serviceId),
    enabled: enabled && !!serviceId,
  })
}
