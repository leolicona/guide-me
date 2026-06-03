import { useMutation, useQueryClient } from '@tanstack/react-query'
import { addExtra } from '../../../services/catalogService'
import type { ExtraInput } from '../../../services/catalogService'
import { SERVICES_QUERY_KEY } from './useServices'

export function useAddExtra(serviceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: ExtraInput) => addExtra(serviceId, data),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [...SERVICES_QUERY_KEY, serviceId],
      }),
  })
}
