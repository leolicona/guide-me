import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { getDb } from '../../db/client'
import { invitations, organizations, users } from '../../db/schema'
import {
  hashPassword,
  initiateMagicLink,
  revokeToken,
  verifyPassword,
  verifyToken,
} from '../../services/agnosticAuth'
import { sendMagicLinkEmail } from '../../services/resend'
import { clearSessionCookies, setSessionCookies } from '../../utils/cookies'
import { extractIdentity } from '../../utils/jwt'
import { ApiError } from '../../types/errors'
import type {
  AcceptInviteQuery,
  CompleteInviteInput,
  LoginInput,
  RegisterInput,
  VerifyQuery,
} from './schema'

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

  const identity = extractIdentity(jwt)
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

export const login = async (c: AuthContext) => {
  const input = (await c.req.json()) as LoginInput
  const db = getDb(c.env)

  const found = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)

  const user = found[0]
  if (!user) {
    throw new ApiError('INVALID_CREDENTIALS', 401, 'Invalid email or password')
  }

  if (user.status === 'unverified') {
    throw new ApiError(
      'EMAIL_NOT_VERIFIED',
      403,
      'Please verify your email before logging in',
    )
  }

  const { jwt, refreshToken } = await verifyPassword(c.env, {
    password: input.password,
    hash: user.passwordHash,
    salt: user.passwordSalt,
    identity: user.email,
  })

  setSessionCookies(c, { jwt, refreshToken })

  return c.json({ user: { name: user.name, role: user.role } }, 200)
}

export const logout = async (c: AuthContext) => {
  const refreshToken = getCookie(c, 'gm_refresh')

  if (refreshToken) {
    await revokeToken(c.env, refreshToken)
  }

  clearSessionCookies(c)

  return c.json({ message: 'Sesión cerrada correctamente.' }, 200)
}

const findValidPendingInvitation = async (
  c: AuthContext,
  token: string,
) => {
  const db = getDb(c.env)
  const found = await db
    .select({
      id: invitations.id,
      organizationId: invitations.organizationId,
      identity: invitations.identity,
      identityType: invitations.identityType,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1)

  const invitation = found[0]
  if (!invitation || invitation.status !== 'pending') {
    throw new ApiError('INVALID_TOKEN', 400, 'Invalid or expired invitation token')
  }

  const expiresAtMs =
    invitation.expiresAt instanceof Date
      ? invitation.expiresAt.getTime()
      : Number(invitation.expiresAt) * 1000

  if (expiresAtMs <= Date.now()) {
    throw new ApiError('INVALID_TOKEN', 400, 'Invalid or expired invitation token')
  }

  return invitation
}

export const acceptInvite = async (c: AuthContext) => {
  const { token } = c.req.query() as AcceptInviteQuery

  const invitation = await findValidPendingInvitation(c, token)

  const db = getDb(c.env)
  const org = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, invitation.organizationId))
    .limit(1)

  return c.json(
    {
      invitation: {
        identity: invitation.identity,
        identity_type: invitation.identityType,
        organization_name: org[0]?.name ?? '',
      },
    },
    200,
  )
}

export const completeInvite = async (c: AuthContext) => {
  const input = (await c.req.json()) as CompleteInviteInput

  const invitation = await findValidPendingInvitation(c, input.token)

  const db = getDb(c.env)

  const { hash, salt } = await hashPassword(c.env, input.password)

  const userId = crypto.randomUUID()

  await db.insert(users).values({
    id: userId,
    organizationId: invitation.organizationId,
    name: input.name,
    email: invitation.identity,
    passwordHash: hash,
    passwordSalt: salt,
    role: 'agent',
    status: 'active',
    plan: 'free',
  })

  await db
    .update(invitations)
    .set({ status: 'accepted', updatedAt: new Date() })
    .where(eq(invitations.id, invitation.id))

  const { jwt, refreshToken } = await verifyPassword(c.env, {
    password: input.password,
    hash,
    salt,
    identity: invitation.identity,
  })

  setSessionCookies(c, { jwt, refreshToken })

  return c.json({ user: { name: input.name, role: 'agent' } }, 200)
}
