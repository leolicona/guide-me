import type { MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { getDb } from '../db/client'
import { users } from '../db/schema'
import { refreshTokens } from '../services/agnosticAuth'
import { clearSessionCookies, setSessionCookies } from '../utils/cookies'
import { decodeJwtPayload } from '../utils/jwt'
import { ApiError } from '../types/errors'
import type { AppVariables, UserPayload, UserRole } from '../types/context'

type AuthEnv = { Bindings: CloudflareBindings; Variables: AppVariables }

interface ResolvedUser {
  payload: UserPayload
  status: string
}

const buildUserPayload = async (
  env: CloudflareBindings,
  identity: string,
): Promise<ResolvedUser | null> => {
  const db = getDb(env)
  const found = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
      affiliateCompanyId: users.affiliateCompanyId,
      status: users.status,
    })
    .from(users)
    .where(eq(users.email, identity))
    .limit(1)

  const user = found[0]
  if (!user) return null

  return {
    payload: {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role as UserRole,
      organizationId: user.organizationId,
      affiliateCompanyId: user.affiliateCompanyId,
    },
    status: user.status,
  }
}

export const authMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const accessToken = getCookie(c, 'gm_access')

  if (!accessToken) {
    throw new ApiError('UNAUTHORIZED', 401, 'Authentication required')
  }

  const payload = decodeJwtPayload(accessToken)
  const identity = payload?.sub ?? payload?.identity ?? null
  const nowSeconds = Math.floor(Date.now() / 1000)
  const isExpired = !payload || (payload.exp != null && payload.exp <= nowSeconds)

  if (!isExpired && identity) {
    const resolved = await buildUserPayload(c.env, identity)
    if (!resolved) {
      clearSessionCookies(c)
      throw new ApiError('UNAUTHORIZED', 401, 'User no longer exists')
    }
    if (resolved.status === 'suspended') {
      clearSessionCookies(c)
      throw new ApiError('ACCOUNT_SUSPENDED', 403, 'Account suspended')
    }
    c.set('user', resolved.payload)
    return next()
  }

  const refreshToken = getCookie(c, 'gm_refresh')
  if (!refreshToken) {
    clearSessionCookies(c)
    throw new ApiError('UNAUTHORIZED', 401, 'Session expired')
  }

  let newTokens: { jwt: string; refreshToken: string }
  try {
    newTokens = await refreshTokens(c.env, refreshToken)
  } catch {
    // Do NOT clear the cookies here (BUG-014). When the access token expires, several
    // queries refetch in parallel and each carries the SAME refresh token; with rotation
    // only one refresh wins. A loser that cleared the cookies could land AFTER the
    // winner's Set-Cookie and wipe the brand-new valid session. A genuinely dead refresh
    // token just keeps 401ing (it grants nothing), so leaving it in place is safe.
    throw new ApiError('UNAUTHORIZED', 401, 'Session expired')
  }

  const newPayload = decodeJwtPayload(newTokens.jwt)
  const newIdentity = newPayload?.sub ?? newPayload?.identity ?? null
  if (!newIdentity) {
    clearSessionCookies(c)
    throw new ApiError('UNAUTHORIZED', 401, 'Session expired')
  }

  const resolved = await buildUserPayload(c.env, newIdentity)
  if (!resolved) {
    clearSessionCookies(c)
    throw new ApiError('UNAUTHORIZED', 401, 'User no longer exists')
  }
  if (resolved.status === 'suspended') {
    clearSessionCookies(c)
    throw new ApiError('ACCOUNT_SUSPENDED', 403, 'Account suspended')
  }

  setSessionCookies(c, newTokens)
  c.set('user', resolved.payload)
  return next()
}
