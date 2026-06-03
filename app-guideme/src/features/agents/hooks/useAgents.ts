import { useQuery } from '@tanstack/react-query'
import { listAgents } from '../../../services/agentsService'

export const AGENTS_QUERY_KEY = ['agents'] as const

export function useAgents() {
  return useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: listAgents,
  })
}
