import type { Context } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'

interface SessionTokens {
  jwt: string
  refreshToken: string
}

const ACCESS_MAX_AGE = 60 * 15 // 15 min
// Idle-session window. Must match `refreshTokenTtlSeconds` in the agnostic-auth
// APP_REGISTRY KV entry for app "guide-me" — KV expires the token server-side
// regardless of this cookie's Max-Age.
const DEFAULT_REFRESH_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

export const setSessionCookies = (
  c: Context<{ Bindings: CloudflareBindings }>,
  { jwt, refreshToken }: SessionTokens,
): void => {
  const domain = c.env.COOKIE_DOMAIN || undefined
  const refreshMaxAge =
    Number(c.env.SESSION_REFRESH_TTL_SECONDS) || DEFAULT_REFRESH_MAX_AGE

  setCookie(c, 'gm_access', jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain,
    maxAge: ACCESS_MAX_AGE,
  })

  setCookie(c, 'gm_refresh', refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain,
    maxAge: refreshMaxAge,
  })
}

export const clearSessionCookies = (
  c: Context<{ Bindings: CloudflareBindings }>,
): void => {
  const domain = c.env.COOKIE_DOMAIN || undefined

  deleteCookie(c, 'gm_access', { path: '/', domain })
  deleteCookie(c, 'gm_refresh', { path: '/', domain })
}

// Operator shift session (US-OP01/OP02). A single httpOnly cookie holding the HMAC-signed shift
// token (24h). No refresh token — when it expires the operator re-enters their PIN via the saved
// link. `OPERATOR_SESSION_MAX_AGE` matches the token's own `exp`.
const OPERATOR_SESSION_MAX_AGE = 60 * 60 * 24 // 24h

export const setOperatorSessionCookie = (
  c: Context<{ Bindings: CloudflareBindings }>,
  token: string,
): void => {
  const domain = c.env.COOKIE_DOMAIN || undefined
  setCookie(c, 'gm_op', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain,
    maxAge: OPERATOR_SESSION_MAX_AGE,
  })
}

export const clearOperatorSessionCookie = (
  c: Context<{ Bindings: CloudflareBindings }>,
): void => {
  const domain = c.env.COOKIE_DOMAIN || undefined
  deleteCookie(c, 'gm_op', { path: '/', domain })
}
