import type { MiddlewareHandler } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { getAuth } from '../auth'
import { ApiError } from '../types/errors'
import type { AppVariables, UserRole } from '../types/context'

type AuthEnv = { Bindings: CloudflareBindings; Variables: AppVariables }

// passkey-auth D6 — every business route reads Better Auth's session and keeps its exact contract:
// 401 UNAUTHORIZED without one, 403 ACCOUNT_SUSPENDED for a suspended user, otherwise
// `c.var.user` as before.
//
// The session cookie is `__Secure-<prefix>.session_token`, HttpOnly and signed with the
// environment secret. There is no cookie cache (D5), so a sign-out, a revocation or a deleted user
// takes effect at the next request (FR-023–FR-025). A renewal extends the same row and never
// rotates the token, so parallel requests cannot race the way BUG-014 did.
export const authMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const { headers, response: session } = await getAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  })

  // A renewal answers a fresh cookie with the new expiry; forward it on whatever we answer.
  for (const cookie of headers?.getSetCookie() ?? []) {
    c.header('Set-Cookie', cookie, { append: true })
  }

  if (!session) {
    throw new ApiError('UNAUTHORIZED', 401, 'Authentication required')
  }

  const { user } = session
  if (user.status === 'suspended') {
    // Refused and this device's cookie cleared, as before (delete-legacy-affiliates D5). The
    // session rows stay, as the refresh tokens did: every request from any device is refused here
    // until an admin reactivates the account.
    const { name, attributes } = (await getAuth(c.env).$context).authCookies.sessionToken
    deleteCookie(c, name, {
      path: attributes.path,
      domain: attributes.domain,
      secure: attributes.secure,
      httpOnly: attributes.httpOnly,
      sameSite: 'Lax',
    })
    throw new ApiError('ACCOUNT_SUSPENDED', 403, 'Account suspended')
  }

  c.set('user', {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role as UserRole,
    organizationId: user.organizationId,
  })
  return next()
}
