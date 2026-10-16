import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  connectDevolada,
  disconnectDevolada,
  getDevoladaConnection,
  type ConnectDevoladaInput,
} from '../../../services/devoladaService'
import { MY_ORG_QUERY_KEY } from '../../organization/hooks/useMyOrganization'

export const DEVOLADA_CONNECTION_QUERY_KEY = ['organization', 'me', 'devolada'] as const

// devolada-transfer-verification D2 — the admin's view of the connection. Its health is read live
// from Devolada on every request, and reading a broken connection re-probes it at most every 15
// minutes server-side, so a short staleTime is enough.
export function useDevoladaConnection(enabled = true) {
  return useQuery({
    queryKey: DEVOLADA_CONNECTION_QUERY_KEY,
    queryFn: getDevoladaConnection,
    staleTime: 30_000,
    enabled,
  })
}

// Connecting or disconnecting changes what the checkout offers: the organization summary every
// screen reads is invalidated with the connection.
const useInvalidateDevolada = () => {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: MY_ORG_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: DEVOLADA_CONNECTION_QUERY_KEY }),
    ])
}

export function useConnectDevolada() {
  const invalidate = useInvalidateDevolada()
  return useMutation({
    mutationFn: (input: ConnectDevoladaInput) => connectDevolada(input),
    onSuccess: invalidate,
  })
}

export function useDisconnectDevolada() {
  const invalidate = useInvalidateDevolada()
  return useMutation({
    mutationFn: () => disconnectDevolada(),
    onSuccess: invalidate,
  })
}
