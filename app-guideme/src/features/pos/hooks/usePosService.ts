import { useQuery } from '@tanstack/react-query'
import { getPosService } from '../../../services/posService'
import type { ServiceDetailRange } from '../../../services/posService'

export const POS_SERVICE_QUERY_KEY = ['pos', 'service'] as const

export function usePosService(
  id: string | undefined,
  range?: ServiceDetailRange,
) {
  return useQuery({
    queryKey: [...POS_SERVICE_QUERY_KEY, id, range ?? {}],
    queryFn: () => getPosService(id as string, range),
    enabled: !!id,
  })
}
