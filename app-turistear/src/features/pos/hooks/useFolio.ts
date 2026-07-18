import { useQuery } from '@tanstack/react-query'
import { getFolio } from '../../../services/posService'

export const FOLIO_QUERY_KEY = ['pos', 'folio'] as const

// A folio is immutable once created, so it can cache indefinitely.
export function useFolio(id: string | undefined) {
  return useQuery({
    queryKey: [...FOLIO_QUERY_KEY, id],
    queryFn: () => getFolio(id as string),
    enabled: !!id,
    staleTime: Infinity,
  })
}
