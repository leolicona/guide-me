import { useMutation } from '@tanstack/react-query'
import { authClient } from '../../../services/authClient'
import { isCancelled, toAuthError } from '../authErrors'
import { useCompleteSignIn } from './useCompleteSignIn'

/**
 * A discoverable sign-in (passkey-auth US2, FR-001): no email is typed — the device offers the
 * accounts it holds for this product. `autoFill` runs it as conditional UI, answered from the email
 * field's autofill instead of a modal prompt.
 *
 * Resolves `true` once signed in and `false` when the person closed the prompt, which the screen
 * returns from silently (US2, scenario 6). A refusal from the server throws an AuthError.
 */
async function signInWithPasskey(autoFill: boolean): Promise<boolean> {
  const { error } = await authClient.signIn.passkey(autoFill ? { autoFill: true } : undefined)
  if (!error) return true
  const authError = toAuthError(error)
  if (isCancelled(authError)) return false
  throw authError
}

export function usePasskeySignIn() {
  const completeSignIn = useCompleteSignIn()

  return useMutation({
    mutationFn: ({ autoFill }: { autoFill: boolean }) => signInWithPasskey(autoFill),
    onSuccess: async (signedIn) => {
      // No offer here: whoever signs in with a llave de acceso already has one.
      if (signedIn) await completeSignIn({ offerPasskey: false })
    },
  })
}
