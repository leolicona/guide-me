import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateExtra } from '../../../services/catalogService'
import type { ExtraInput } from '../../../services/catalogService'
import { SERVICES_QUERY_KEY } from './useServices'

export function useUpdateExtra(serviceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ extraId, data }: { extraId: string; data: ExtraInput }) =>
      updateExtra(serviceId, extraId, data),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [...SERVICES_QUERY_KEY, serviceId],
      }),
  })
}
