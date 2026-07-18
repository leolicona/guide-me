import { useMutation, useQueryClient } from '@tanstack/react-query'
import { reactivateAgent } from '../../../services/agentsService'
import { AGENTS_QUERY_KEY } from './useAgents'

export function useReactivateAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => reactivateAgent(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY }),
  })
}
