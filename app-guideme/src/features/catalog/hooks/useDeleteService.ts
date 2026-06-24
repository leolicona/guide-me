import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteService } from '../../../services/catalogService'
import { SERVICES_QUERY_KEY } from './useServices'

// US-A58 — guarded hard-delete. On success the service is gone; on 409 SERVICE_HAS_FOLIOS the
// caller surfaces a "deactivate instead" message (the service has sales history).
export function useDeleteService() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteService(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY }),
  })
}
