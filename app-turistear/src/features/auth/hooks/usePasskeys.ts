import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authClient } from '../../../services/authClient'
import { toAuthError } from '../authErrors'
import type { PasskeyRecord } from '../types'

// passkey-auth US5, FR-040 — the signed-in user's own llaves de acceso, through Better Auth's
// standard passkey routes. Each route acts only on the caller's own rows (proven in the API).

export const PASSKEYS_QUERY_KEY = ['passkeys'] as const

export function usePasskeys() {
  return useQuery({
    queryKey: PASSKEYS_QUERY_KEY,
    queryFn: async (): Promise<PasskeyRecord[]> => {
      const { data, error } = await authClient.passkey.listUserPasskeys()
      if (error) throw toAuthError(error)
      return data ?? []
    },
  })
}

export function useRenamePasskey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const { error } = await authClient.passkey.updatePasskey({ id, name })
      if (error) throw toAuthError(error)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY }),
  })
}

// US5 (scenario 2) — removing the last one is allowed: the email code still signs in.
export function useRemovePasskey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await authClient.passkey.deletePasskey({ id })
      if (error) throw toAuthError(error)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY }),
  })
}
