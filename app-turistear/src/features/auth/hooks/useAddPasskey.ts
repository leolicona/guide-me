import { useMutation, useQueryClient } from '@tanstack/react-query'
import { authClient } from '../../../services/authClient'
import { isCancelled, toAuthError } from '../authErrors'
import { defaultPasskeyName } from '../webauthn'
import { PASSKEYS_QUERY_KEY } from './usePasskeys'

/**
 * Creates a llave de acceso on this device or a security key (passkey-auth US2, FR-004). The
 * server asks for a session less than a day old (FR-005) and answers `SESSION_NOT_FRESH` otherwise.
 *
 * Resolves `true` once saved and `false` when the person closed the device's prompt (US2,
 * scenario 6); a refusal throws an AuthError.
 */
async function addPasskey(): Promise<boolean> {
  const { error } = await authClient.passkey.addPasskey({ name: defaultPasskeyName() })
  if (!error) return true
  const authError = toAuthError(error)
  if (isCancelled(authError)) return false
  throw authError
}

export function useAddPasskey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: addPasskey,
    onSuccess: (added) =>
      added ? queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY }) : undefined,
  })
}
