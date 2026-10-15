import { useMutation } from '@tanstack/react-query'
import { acceptInvitation } from '../../../services/authService'

// passkey-auth US4, D11 — accepting creates the agent and sends a sign-in code to the invited
// address, which the answer returns; signing in is then the código por correo.
export function useInviteComplete() {
  return useMutation({
    mutationFn: ({ token, name }: { token: string; name: string }) => acceptInvitation(token, name),
  })
}
