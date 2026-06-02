import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { organizations, users } from '../../db/schema'
import {
  hashPassword,
  initiateMagicLink,
  verifyToken,
} from '../../services/agnosticAuth'
import { sendMagicLinkEmail } from '../../services/resend'
import { setSessionCookies } from '../../utils/cookies'
import { ApiError } from '../../types/errors'
import type { RegisterInput, VerifyQuery } from './schema'

type AuthContext = Context<{ Bindings: CloudflareBindings }>

export const register = async (c: AuthContext) => {
  const input = (await c.req.json()) as RegisterInput
  const db = getDb(c.env)

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)

  if (existing.length > 0) {
    throw new ApiError(
      'EMAIL_ALREADY_EXISTS',
      409,
      'An account with this email already exists',
    )
  }

  const { hash, salt } = await hashPassword(c.env, input.password)

  const organizationId = crypto.randomUUID()
  const userId = crypto.randomUUID()

  await db.insert(organizations).values({
    id: organizationId,
    name: input.company_name,
  })

  await db.insert(users).values({
    id: userId,
    organizationId,
    name: input.name,
    email: input.email,
    passwordHash: hash,
    passwordSalt: salt,
    phone: input.phone,
    role: 'admin',
    status: 'unverified',
    plan: 'free',
  })

  const { token } = await initiateMagicLink(c.env, input.email)
  const magicLink = `${c.env.API_BASE_URL}/api/auth/verify?token=${token}`

  await sendMagicLinkEmail(c.env, {
    to: input.email,
    name: input.name,
    magicLink,
  })

  return c.json(
    { message: 'Registro exitoso. Revisa tu correo para verificar tu cuenta.' },
    201,
  )
}

export const verify = async (c: AuthContext) => {
  const { token } = c.req.query() as VerifyQuery

  const { jwt, refreshToken } = await verifyToken(c.env, token)

  const db = getDb(c.env)

  const identity = extractIdentityFromJwt(jwt)
  if (!identity) {
    throw new ApiError('INVALID_TOKEN', 400, 'Invalid token payload')
  }

  const found = await db
    .select()
    .from(users)
    .where(eq(users.email, identity))
    .limit(1)

  const user = found[0]
  if (!user) {
    throw new ApiError('INVALID_TOKEN', 400, 'User not found for token')
  }

  await db
    .update(users)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(users.id, user.id))

  setSessionCookies(c, { jwt, refreshToken })

  return c.json(
    { user: { name: user.name, role: user.role } },
    200,
  )
}

const extractIdentityFromJwt = (jwt: string): string | null => {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.sub ?? payload.identity ?? null
  } catch {
    return null
  }
}
