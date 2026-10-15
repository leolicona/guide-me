import { useMutation } from '@tanstack/react-query'
import { authClient } from '../../../services/authClient'
import { retryAfterProbe, toAuthError } from '../authErrors'
import { useCompleteSignIn } from './useCompleteSignIn'

// passkey-auth US1, D7 — Better Auth's emailOTP: a 6-digit code, single use, 5 minutes, 3 tries.
// The answer to a request is the same whether or not the address has an account (FR-013), so the
// screen never tells them apart either.

async function sendSignInCode(email: string): Promise<void> {
  const retryAfter = retryAfterProbe()
  const { error } = await authClient.emailOtp.sendVerificationOtp({
    email,
    type: 'sign-in',
    fetchOptions: { onError: retryAfter.onError },
  })
  if (error) throw toAuthError(error, retryAfter.seconds)
}

async function signInWithCode({ email, code }: { email: string; code: string }): Promise<void> {
  const retryAfter = retryAfterProbe()
  // The answer is `{ user }` and the session is the cookie it sets (BFF): nothing to read here.
  const { error } = await authClient.signIn.emailOtp({
    email,
    otp: code,
    fetchOptions: { onError: retryAfter.onError },
  })
  if (error) throw toAuthError(error, retryAfter.seconds)
}

export function useEmailCodeSignIn() {
  const completeSignIn = useCompleteSignIn()

  const sendCode = useMutation({ mutationFn: sendSignInCode })

  const signIn = useMutation({
    mutationFn: signInWithCode,
    // US2 (scenario 1) — a code sign-in is the moment to offer a llave de acceso.
    onSuccess: () => completeSignIn({ offerPasskey: true }),
  })

  return { sendCode, signIn }
}
