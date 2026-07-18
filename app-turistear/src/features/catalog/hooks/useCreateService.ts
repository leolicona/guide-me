import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createService } from '../../../services/catalogService'
import type { ServiceInput } from '../../../services/catalogService'
import { SERVICES_QUERY_KEY } from './useServices'

export function useCreateService() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: ServiceInput) => createService(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY }),
  })
}
