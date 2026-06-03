import { useQuery } from '@tanstack/react-query'
import { getService } from '../../../services/catalogService'
import { SERVICES_QUERY_KEY } from './useServices'

export function useService(id: string | undefined) {
  return useQuery({
    queryKey: [...SERVICES_QUERY_KEY, id],
    queryFn: () => getService(id as string),
    enabled: !!id,
  })
}
