import { useMutation, useQueryClient } from '@tanstack/react-query'
import { reactivateService } from '../../../services/catalogService'
import { SERVICES_QUERY_KEY } from './useServices'

export function useReactivateService() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => reactivateService(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY }),
  })
}
