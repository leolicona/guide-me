import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateService } from '../../../services/catalogService'
import type { ServiceInput } from '../../../services/catalogService'
import { SERVICES_QUERY_KEY } from './useServices'

export function useUpdateService() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ServiceInput }) =>
      updateService(id, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY }),
  })
}
