import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getMe } from '../../../services/authService'
import { ROUTES } from '../../../config/routes'
import { usePasskeyOffer } from '../../../store/passkeyOffer'
import { passkeysSupported } from '../webauthn'

/** A `?redirect=` that stays inside the app: a path, never `//host` (an open redirect). */
const safeRedirect = (raw: string | null) =>
  raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : null

/**
 * What every sign-in does once Better Auth has set the session cookie, whichever way it got there
 * (código por correo or llave de acceso).
 *
 * passkey-auth D14 — the app never reads the session itself (BFF, constitution IV): `/api/me` says
 * who signed in. `['me']` is invalidated and resolved BEFORE navigating, so AuthGuard mounts on an
 * already-authenticated success state instead of a stale or empty one that bounces back to /login
 * while the refetch is in flight. A safe `?redirect=` wins; otherwise the role's landing (US-UX01:
 * admin → Hoy, agent → Vender).
 */
export function useCompleteSignIn() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestOffer = usePasskeyOffer((s) => s.request)
  const redirect = safeRedirect(searchParams.get('redirect'))

  return useCallback(
    async ({ offerPasskey }: { offerPasskey: boolean }) => {
      // FR-007, SC-008 — an email-code sign-in on a device that can hold a llave de acceso is
      // followed by the offer to create one (AppLayout's PasskeyOffer reads this flag).
      if (offerPasskey && passkeysSupported()) requestOffer()

      await queryClient.invalidateQueries({ queryKey: ['me'] })
      let landing: string = ROUTES.POS
      try {
        const me = await queryClient.fetchQuery({
          queryKey: ['me'],
          queryFn: getMe,
          // useMe's retry:false is an observer option fetchQuery does not inherit; without it a
          // genuinely failing /api/me is retried 3× behind a frozen button.
          retry: false,
        })
        landing = me.role === 'admin' ? ROUTES.DASHBOARD : ROUTES.POS
      } catch {
        // A failing /api/me right after a successful sign-in is a real session problem, not a
        // race: AuthGuard sends the user back to /login.
      }
      navigate(redirect ?? landing, { replace: true })
    },
    [queryClient, navigate, requestOffer, redirect],
  )
}
