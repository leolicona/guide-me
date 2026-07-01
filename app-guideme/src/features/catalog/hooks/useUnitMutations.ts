import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createUnit,
  updateUnit,
  deactivateUnit,
  reactivateUnit,
  type UnitInput,
} from '../../../services/lodgingCatalogService'
import { SERVICES_QUERY_KEY } from './useServices'
import { unitsQueryKey } from './useUnits'

// US-A59 — unit mutations. Each invalidates the unit list for the service (and the catalog
// list, since "Desde $X/noche" on the service card derives from the units).
export function useUnitMutations(serviceId: string) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: unitsQueryKey(serviceId) })
    queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY })
  }

  const create = useMutation({
    mutationFn: (data: UnitInput) => createUnit(serviceId, data),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: ({ unitId, data }: { unitId: string; data: UnitInput }) =>
      updateUnit(serviceId, unitId, data),
    onSuccess: invalidate,
  })
  const deactivate = useMutation({
    mutationFn: (unitId: string) => deactivateUnit(serviceId, unitId),
    onSuccess: invalidate,
  })
  const reactivate = useMutation({
    mutationFn: (unitId: string) => reactivateUnit(serviceId, unitId),
    onSuccess: invalidate,
  })

  return { create, update, deactivate, reactivate }
}
