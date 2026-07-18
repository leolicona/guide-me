import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateAgent } from '../../../services/agentsService'
import type { UpdateAgentInput } from '../../../services/agentsService'
import { AGENTS_QUERY_KEY } from './useAgents'

export function useUpdateAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAgentInput }) =>
      updateAgent(id, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY }),
  })
}
