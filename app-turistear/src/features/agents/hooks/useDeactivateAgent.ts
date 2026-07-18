import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deactivateAgent } from '../../../services/agentsService'
import { AGENTS_QUERY_KEY } from './useAgents'

export function useDeactivateAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deactivateAgent(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY }),
  })
}
