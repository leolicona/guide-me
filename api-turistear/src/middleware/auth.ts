import type { MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { getDb } from '../db/client'
import { affiliateOperators, users } from '../db/schema'
import { refreshTokens } from '../services/agnosticAuth'
import {
  clearOperatorSessionCookie,
  clearSessionCookies,
  setSessionCookies,
} from '../utils/cookies'
import { decodeJwtPayload } from '../utils/jwt'
import { verifyOperatorSession } from '../utils/operatorSession'
import { ApiError } from '../types/errors'
import type { AppVariables, UserPayload, UserRole } from '../types/context'

type AuthEnv = { Bindings: CloudflareBindings; Variables: AppVariables }

interface ResolvedUser {
  payload: UserPayload
  status: string
}

// An operator shift session (US-OP01/OP02) is a separate httpOnly cookie (`gm_op`) holding an
// HMAC-signed token. It borrows the owning manager's identity (D5): resolve the operator → its
// manager user → set `user` to the manager and `operator` to who's actually at the register. A
// removed operator (or a manager gone missing) → the shift is dead. Returns true iff it handled
// the request (a valid operator session, or an invalid `gm_op` cookie we rejected).
const tryOperatorSession = async (
  c: Parameters<MiddlewareHandler<AuthEnv>>[0],
): Promise<boolean> => {
  const opToken = getCookie(c, 'gm_op')
  if (!opToken) return false

  const operatorId = await verifyOperatorSession(c.env.QR_SECRET, opToken)
  if (!operatorId) {
    clearOperatorSessionCookie(c)
    throw new ApiError('UNAUTHORIZED', 401, 'Shift session expired')
  }

  const db = getDb(c.env)
  const opRows = await db
    .select()
    .from(affiliateOperators)
    .where(eq(affiliateOperators.id, operatorId))
    .limit(1)
  const operator = opRows[0]
  if (!operator || operator.status !== 'active') {
    clearOperatorSessionCookie(c)
    throw new ApiError('UNAUTHORIZED', 401, 'Operator access revoked')
  }

  const mgrRows = await db
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
    .where(eq(users.id, operator.managerId))
    .limit(1)
  const manager = mgrRows[0]
  if (!manager || manager.status === 'suspended') {
    clearOperatorSessionCookie(c)
    throw new ApiError('UNAUTHORIZED', 401, 'Operator access revoked')
  }

  c.set('user', {
    userId: manager.id,
    name: manager.name,
    email: manager.email,
    role: manager.role as UserRole,
    organizationId: manager.organizationId,
    affiliateCompanyId: manager.affiliateCompanyId,
  })
  c.set('operator', {
    operatorId: operator.id,
    name: operator.name,
    affiliateCompanyId: operator.affiliateCompanyId,
  })
  return true
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
  // Operator shift sessions (gm_op) take precedence — they borrow the manager's identity.
  if (await tryOperatorSession(c)) return next()

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
