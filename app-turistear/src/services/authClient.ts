import { createAuthClient } from 'better-auth/react'
import { emailOTPClient } from 'better-auth/client/plugins'
import { passkeyClient } from '@better-auth/passkey/client'

// passkey-auth D14 — the app talks to /api/auth/* only through Better Auth's own client: the email
// code (emailOTP) and the llave de acceso (passkey) plugins, configured, never wrapped (D2).
//
// The BFF holds (constitution IV, v1.2.1): the session lives in an HttpOnly cookie the API sets, so
// every call goes out with `credentials: 'include'` and nothing here reads, stores or sends a token.
// The app never calls `getSession` / `useSession` — those routes are disabled (D2); who is signed in
// is read from `/api/me` (`useMe`) alone.
export const authClient = createAuthClient({
  baseURL: (import.meta.env.VITE_API_BASE_URL as string | undefined) || window.location.origin,
  basePath: '/api/auth',
  plugins: [emailOTPClient(), passkeyClient()],
  fetchOptions: {
    credentials: 'include',
    // Resolve `fetch` at call time, not when this module loads. Better Auth captures the global
    // `fetch` by reference when the client is created; binding late keeps any later wrapper of the
    // global (MSW in the test suite installs one after the modules are imported) in the path.
    customFetchImpl: (input, init) => fetch(input, init),
  },
})
