import { useQuery } from '@tanstack/react-query'
import { listServices } from '../../../services/catalogService'
import type { ServiceStatus } from '../types'

export const SERVICES_QUERY_KEY = ['services'] as const

export function useServices(status?: ServiceStatus) {
  return useQuery({
    queryKey: [...SERVICES_QUERY_KEY, status],
    queryFn: () => listServices(status),
  })
}
