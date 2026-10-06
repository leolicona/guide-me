import type { Context } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'

interface SessionTokens {
  jwt: string
  refreshToken: string
}

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

  // BOTH cookies carry the idle-session window. The access cookie used to expire in 15 min, which
  // was never a security control — the JWT's own `exp` (10 min) is the gate, and authMiddleware
  // checks it on every request. All the short Max-Age did was DELETE the cookie during any idle
  // gap, and a request with no `gm_access` was refused outright instead of being renewed from the
  // still-valid `gm_refresh` sitting beside it. The cookie now simply outlives the token it holds.
  setCookie(c, 'gm_access', jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain,
    maxAge: refreshMaxAge,
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
