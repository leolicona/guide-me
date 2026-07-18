import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listBlockouts,
  createBlockout,
  deleteBlockout,
  type BlockoutInput,
} from '../../../services/lodgingCatalogService'

export const blockoutsQueryKey = (unitId: string) => ['blockouts', unitId] as const

// US-A61 — a unit's block-out dates (maintenance / owner days).
export function useBlockouts(serviceId: string, unitId: string, enabled = true) {
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: blockoutsQueryKey(unitId) })

  const query = useQuery({
    queryKey: blockoutsQueryKey(unitId),
    queryFn: () => listBlockouts(serviceId, unitId),
    enabled: enabled && !!serviceId && !!unitId,
  })
  const create = useMutation({
    mutationFn: (data: BlockoutInput) => createBlockout(serviceId, unitId, data),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (blockoutId: string) => deleteBlockout(serviceId, unitId, blockoutId),
    onSuccess: invalidate,
  })

  return { query, create, remove }
}
