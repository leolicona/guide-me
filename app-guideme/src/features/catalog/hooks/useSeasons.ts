import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listSeasons,
  createSeason,
  deleteSeason,
  type SeasonInput,
} from '../../../services/lodgingCatalogService'

export const seasonsQueryKey = (unitId: string) => ['seasons', unitId] as const

// US-A60 — a unit's seasonal rates. create raises 409 SEASON_OVERLAP on overlap.
export function useSeasons(serviceId: string, unitId: string, enabled = true) {
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: seasonsQueryKey(unitId) })

  const query = useQuery({
    queryKey: seasonsQueryKey(unitId),
    queryFn: () => listSeasons(serviceId, unitId),
    enabled: enabled && !!serviceId && !!unitId,
  })
  const create = useMutation({
    mutationFn: (data: SeasonInput) => createSeason(serviceId, unitId, data),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (seasonId: string) => deleteSeason(serviceId, unitId, seasonId),
    onSuccess: invalidate,
  })

  return { query, create, remove }
}
