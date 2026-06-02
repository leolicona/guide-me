import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'

interface SessionTokens {
  jwt: string
  refreshToken: string
}

const ACCESS_MAX_AGE = 60 * 15 // 15 min
const REFRESH_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

export const setSessionCookies = (
  c: Context<{ Bindings: CloudflareBindings }>,
  { jwt, refreshToken }: SessionTokens,
): void => {
  const domain = c.env.COOKIE_DOMAIN || undefined

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
    path: '/api/auth/refresh',
    domain,
    maxAge: REFRESH_MAX_AGE,
  })
}
