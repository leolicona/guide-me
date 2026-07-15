import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createUnitType,
  updateUnitType,
  deactivateUnitType,
  reactivateUnitType,
  type UnitTypeInput,
} from '../../../services/lodgingCatalogService'
import { SERVICES_QUERY_KEY } from './useServices'
import { unitsQueryKey } from './useUnits'

// US-A59 (v2) — unit-type mutations. Each invalidates the type list for the service (and the
// catalog list, since availability/rates on the POS type cards derive from the types).
export function useUnitMutations(serviceId: string) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: unitsQueryKey(serviceId) })
    queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY })
  }

  const create = useMutation({
    mutationFn: (data: UnitTypeInput) => createUnitType(serviceId, data),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: ({ unitId, data }: { unitId: string; data: UnitTypeInput }) =>
      updateUnitType(serviceId, unitId, data),
    onSuccess: invalidate,
  })
  const deactivate = useMutation({
    mutationFn: (unitId: string) => deactivateUnitType(serviceId, unitId),
    onSuccess: invalidate,
  })
  const reactivate = useMutation({
    mutationFn: (unitId: string) => reactivateUnitType(serviceId, unitId),
    onSuccess: invalidate,
  })

  return { create, update, deactivate, reactivate }
}
