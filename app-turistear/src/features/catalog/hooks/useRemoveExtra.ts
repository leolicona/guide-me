import { useMutation, useQueryClient } from '@tanstack/react-query'
import { removeExtra } from '../../../services/catalogService'
import { SERVICES_QUERY_KEY } from './useServices'

export function useRemoveExtra(serviceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (extraId: string) => removeExtra(serviceId, extraId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [...SERVICES_QUERY_KEY, serviceId],
      }),
  })
}
