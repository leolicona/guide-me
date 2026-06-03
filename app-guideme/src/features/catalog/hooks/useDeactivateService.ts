import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deactivateService } from '../../../services/catalogService'
import { SERVICES_QUERY_KEY } from './useServices'

export function useDeactivateService() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deactivateService(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY }),
  })
}
