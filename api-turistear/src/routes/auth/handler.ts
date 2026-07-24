import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { getDb } from '../../db/client'
import {
  affiliateCompanies,
  affiliateInvitations,
  invitations,
  organizations,
  passwordResetTokens,
  users,
} from '../../db/schema'
import {
  hashPassword,
  initiateMagicLink,
  revokeToken,
  verifyPassword,
  verifyToken,
} from '../../services/agnosticAuth'
import { sendMagicLinkEmail, sendPasswordResetEmail } from '../../services/resend'
import { clearSessionCookies, setSessionCookies } from '../../utils/cookies'
import { extractIdentity } from '../../utils/jwt'
import { ApiError } from '../../types/errors'
import type {
  AcceptInviteQuery,
  CompleteInviteInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  VerifyQuery,
} from './schema'

const PASSWORD_RESET_TTL_SECONDS = 60 * 60
const GENERIC_FORGOT_RESPONSE = {
  message: 'Si el correo está registrado, recibirás instrucciones.',
}

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
  const magicLink = `${c.env.APP_BASE_URL}/verify?token=${token}`

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
  // POST body for the app client (BUG-010 — a state-changing call must not be a
  // refetchable GET); query string for the legacy GET deep-link. Both zod-validated.
  const { token } =
    c.req.method === 'POST'
      ? ((await c.req.json()) as VerifyQuery)
      : (c.req.query() as VerifyQuery)

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

// Resolves a token across BOTH invite tables (D8 parallel flow). An agent invite lives in
// `invitations`; an affiliate invite in `affiliate_invitations` and carries the company link.
// Tokens are crypto-random UUIDs, so there is no cross-table collision; the agent path is
// checked first and is byte-identical to before for an agent token.
type ResolvedInvitation =
  | {
      kind: 'agent'
      id: string
      organizationId: string
      identity: string
      identityType: 'email'
    }
  | {
      kind: 'affiliate'
      id: string
      organizationId: string
      identity: string
      identityType: 'email'
      affiliateCompanyId: string
    }

const expiredOrMissing = (
  status: string | undefined,
  expiresAt: Date | number | null | undefined,
): boolean => {
  if (status !== 'pending' || expiresAt == null) return true
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt) * 1000
  return ms <= Date.now()
}

const findAnyValidPendingInvitation = async (
  c: AuthContext,
  token: string,
): Promise<ResolvedInvitation> => {
  const db = getDb(c.env)

  const agentRows = await db
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
  const agent = agentRows[0]
  if (agent && !expiredOrMissing(agent.status, agent.expiresAt)) {
    return {
      kind: 'agent',
      id: agent.id,
      organizationId: agent.organizationId,
      identity: agent.identity,
      identityType: agent.identityType,
    }
  }

  const affRows = await db
    .select({
      id: affiliateInvitations.id,
      organizationId: affiliateInvitations.organizationId,
      affiliateCompanyId: affiliateInvitations.affiliateCompanyId,
      identity: affiliateInvitations.identity,
      identityType: affiliateInvitations.identityType,
      status: affiliateInvitations.status,
      expiresAt: affiliateInvitations.expiresAt,
    })
    .from(affiliateInvitations)
    .where(eq(affiliateInvitations.token, token))
    .limit(1)
  const aff = affRows[0]
  if (aff && !expiredOrMissing(aff.status, aff.expiresAt)) {
    return {
      kind: 'affiliate',
      id: aff.id,
      organizationId: aff.organizationId,
      identity: aff.identity,
      identityType: aff.identityType,
      affiliateCompanyId: aff.affiliateCompanyId,
    }
  }

  throw new ApiError('INVALID_TOKEN', 400, 'Invalid or expired invitation token')
}

export const acceptInvite = async (c: AuthContext) => {
  const { token } = c.req.query() as AcceptInviteQuery

  const invitation = await findAnyValidPendingInvitation(c, token)

  const db = getDb(c.env)
  const org = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, invitation.organizationId))
    .limit(1)

  // For an affiliate invite, surface the (admin-created) company name so the acceptance form
  // can show it read-only ("Te unes a: …", US-AF01).
  let companyName: string | null = null
  if (invitation.kind === 'affiliate') {
    const co = await db
      .select({ name: affiliateCompanies.name })
      .from(affiliateCompanies)
      .where(eq(affiliateCompanies.id, invitation.affiliateCompanyId))
      .limit(1)
    companyName = co[0]?.name ?? null
  }

  return c.json(
    {
      invitation: {
        identity: invitation.identity,
        identity_type: invitation.identityType,
        organization_name: org[0]?.name ?? '',
        invitation_type: invitation.kind,
        company_name: companyName,
      },
    },
    200,
  )
}

export const completeInvite = async (c: AuthContext) => {
  const input = (await c.req.json()) as CompleteInviteInput

  const invitation = await findAnyValidPendingInvitation(c, input.token)

  const db = getDb(c.env)

  const { hash, salt } = await hashPassword(c.env, input.password)

  const userId = crypto.randomUUID()
  const isAffiliate = invitation.kind === 'affiliate'
  const role = isAffiliate ? 'affiliate' : 'agent'

  // D13 (docs/affiliate-operators/spec.md) — at most ONE affiliate (the manager) per company. Guard
  // the accept path too (a race where a stale second invite is redeemed): if a manager already
  // exists for this company, refuse. Extra sellers are added as PIN operators (US-AF10).
  if (isAffiliate) {
    const existingManager = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.affiliateCompanyId, invitation.affiliateCompanyId),
          eq(users.role, 'affiliate'),
        ),
      )
      .limit(1)
    if (existingManager.length > 0) {
      throw new ApiError(
        'AFFILIATE_MANAGER_EXISTS',
        409,
        'Esta empresa ya tiene un gerente registrado.',
      )
    }
  }

  await db.insert(users).values({
    id: userId,
    organizationId: invitation.organizationId,
    name: input.name,
    email: invitation.identity,
    passwordHash: hash,
    passwordSalt: salt,
    role,
    status: 'active',
    plan: 'free',
    // US-AF01 — link the affiliate user to its company + optional job title. Null for an agent.
    affiliateCompanyId: isAffiliate ? invitation.affiliateCompanyId : null,
    position: isAffiliate ? input.position?.trim() || null : null,
  })

  if (isAffiliate) {
    await db
      .update(affiliateInvitations)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(eq(affiliateInvitations.id, invitation.id))
  } else {
    await db
      .update(invitations)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(eq(invitations.id, invitation.id))
  }

  const { jwt, refreshToken } = await verifyPassword(c.env, {
    password: input.password,
    hash,
    salt,
    identity: invitation.identity,
  })

  setSessionCookies(c, { jwt, refreshToken })

  return c.json({ user: { name: input.name, role } }, 200)
}

const findValidPasswordResetToken = async (
  c: AuthContext,
  token: string,
) => {
  const db = getDb(c.env)
  const found = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.token, token))
    .limit(1)

  const resetToken = found[0]
  if (!resetToken) {
    throw new ApiError('INVALID_TOKEN', 400, 'Invalid or expired reset token')
  }

  const expiresAtMs =
    resetToken.expiresAt instanceof Date
      ? resetToken.expiresAt.getTime()
      : Number(resetToken.expiresAt) * 1000

  if (expiresAtMs <= Date.now()) {
    throw new ApiError('INVALID_TOKEN', 400, 'Invalid or expired reset token')
  }

  return resetToken
}

export const forgotPassword = async (c: AuthContext) => {
  const input = (await c.req.json()) as ForgotPasswordInput
  const db = getDb(c.env)

  const found = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)

  const user = found[0]
  if (!user) {
    return c.json(GENERIC_FORGOT_RESPONSE, 200)
  }

  await db
    .delete(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, user.id))

  const token = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000)

  await db.insert(passwordResetTokens).values({
    id: crypto.randomUUID(),
    userId: user.id,
    token,
    expiresAt,
  })

  const resetLink = `${c.env.APP_BASE_URL}/reset-password?token=${token}`

  await sendPasswordResetEmail(c.env, {
    to: user.email,
    name: user.name,
    resetLink,
  })

  return c.json(GENERIC_FORGOT_RESPONSE, 200)
}

export const resetPassword = async (c: AuthContext) => {
  const input = (await c.req.json()) as ResetPasswordInput

  const resetToken = await findValidPasswordResetToken(c, input.token)

  const db = getDb(c.env)

  const { hash, salt } = await hashPassword(c.env, input.password)

  await db
    .update(users)
    .set({
      passwordHash: hash,
      passwordSalt: salt,
      updatedAt: new Date(),
    })
    .where(eq(users.id, resetToken.userId))

  await db
    .delete(passwordResetTokens)
    .where(eq(passwordResetTokens.id, resetToken.id))

  return c.json({ message: 'Contraseña actualizada correctamente.' }, 200)
}
