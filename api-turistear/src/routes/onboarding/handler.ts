import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { getAuth } from '../../auth'
import { getDb, type Db } from '../../db/client'
import { invitations, organizations, users } from '../../db/schema'
import { DEFAULT_CANCELLATION_POLICY } from '../../utils/cancellationPolicy'
import { ApiError } from '../../types/errors'
import type { AcceptInvitationInput, RegisterInput } from './schema'

type OnboardingContext = Context<{ Bindings: CloudflareBindings }>

const emailTaken = () =>
  new ApiError('EMAIL_ALREADY_EXISTS', 409, 'An account with this email already exists')

const isUniqueViolation = (err: unknown) =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message + String(err.cause ?? ''))

// passkey-auth D15, debt `password-material` — migration 0072 drops `users.password_hash` and
// `password_salt`, and a migration runs before the code it ships with, so a new user has to be
// insertable on both sides of the drop. Until it, the columns are NOT NULL with no default and the
// insert writes '' into both through this insert-only view of the table (kept out of db/schema.ts,
// so neither Drizzle's relational schema nor Better Auth sees a second `users`); after it, an
// insert that names them fails before anything is written, and the same rows go in through `users`.
// The drop's own pull request deletes this view and the fallback.
const usersWithPasswordColumns = sqliteTable('users', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash')
    .notNull()
    .$defaultFn(() => ''),
  passwordSalt: text('password_salt')
    .notNull()
    .$defaultFn(() => ''),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  phone: text('phone'),
  role: text('role', { enum: ['admin', 'agent'] }).notNull(),
  status: text('status', { enum: ['unverified', 'active', 'suspended'] }).notNull(),
  plan: text('plan').notNull(),
})

type NewUser = typeof usersWithPasswordColumns.$inferInsert

const insertUser = (db: Db, withPasswordColumns: boolean, user: NewUser) =>
  withPasswordColumns
    ? db.insert(usersWithPasswordColumns).values(user)
    : db.insert(users).values(user)

const passwordColumnsDropped = (err: unknown) =>
  err instanceof Error &&
  /no column named password_(hash|salt)/i.test(err.message + String(err.cause ?? ''))

// D1 runs a batch as one transaction, so a first attempt refused by the drop leaves nothing behind.
const acrossTheDrop = async (write: (withPasswordColumns: boolean) => Promise<unknown>) => {
  try {
    await write(true)
  } catch (err) {
    if (!passwordColumnsDropped(err)) throw err
    await write(false)
  }
}

// passkey-auth D10, D11 — the sign-in code goes out through Better Auth's own emailOTP plugin, so
// one code path verifies every address (FR-015). It sends in the background, like any other.
const sendSignInCode = (c: OnboardingContext, email: string) =>
  getAuth(c.env).api.sendVerificationOTP({ body: { email, type: 'sign-in' } })

const emailExists = async (c: OnboardingContext, email: string) => {
  const found = await getDb(c.env)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  return found.length > 0
}

// passkey-auth D10, US3 — an organization signs up with no password. Its admin is `unverified`
// until the code arrives and is entered; the session-create hook then makes it `active` (D6).
export const register = async (c: OnboardingContext) => {
  const input = (await c.req.json()) as RegisterInput
  const email = input.email.trim().toLowerCase()

  if (await emailExists(c, email)) throw emailTaken()

  const db = getDb(c.env)
  const organizationId = crypto.randomUUID()
  try {
    // One batch: D1 runs it as one transaction, so an organization never exists without its admin.
    await acrossTheDrop((withPasswordColumns) =>
      db.batch([
        db.insert(organizations).values({
          id: organizationId,
          name: input.company_name,
          // D17 (cancellation policy) — a new org is born WITH a cancellation policy, as before.
          cancellationPolicy: JSON.stringify(DEFAULT_CANCELLATION_POLICY),
        }),
        insertUser(db, withPasswordColumns, {
          id: crypto.randomUUID(),
          organizationId,
          name: input.name,
          email,
          emailVerified: false,
          phone: input.phone,
          role: 'admin',
          status: 'unverified',
          plan: 'free',
        }),
      ]),
    )
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken()
    throw err
  }

  await sendSignInCode(c, email)

  return c.json({ message: 'Te enviamos un código a tu correo.' }, 201)
}

// retire-affiliates (FR-004) — only agent invitations exist; any other token answers INVALID_TOKEN.
const findValidPendingInvitation = async (c: OnboardingContext, token: string) => {
  const [invitation] = await getDb(c.env)
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

  const expiresAtMs =
    invitation?.expiresAt instanceof Date
      ? invitation.expiresAt.getTime()
      : Number(invitation?.expiresAt) * 1000
  if (!invitation || invitation.status !== 'pending' || !(expiresAtMs > Date.now())) {
    throw new ApiError('INVALID_TOKEN', 400, 'Invalid or expired invitation token')
  }
  return invitation
}

// passkey-auth D11 — the lookup, moved from GET /api/auth/invite/accept.
export const getInvitation = async (c: OnboardingContext) => {
  const invitation = await findValidPendingInvitation(c, c.req.param('token')!)

  const [org] = await getDb(c.env)
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, invitation.organizationId))
    .limit(1)

  return c.json(
    {
      invitation: {
        identity: invitation.identity,
        identity_type: invitation.identityType,
        organization_name: org?.name ?? '',
      },
    },
    200,
  )
}

// passkey-auth D11, US4 — the invited agent gives a name; the invitation proved the address, so the
// account is born `active` and verified. The app then shows the code step for the returned email.
export const acceptInvitation = async (c: OnboardingContext) => {
  const input = (await c.req.json()) as AcceptInvitationInput
  const invitation = await findValidPendingInvitation(c, c.req.param('token')!)
  // R11 — an invitation from before migration 0071 may still carry its address as typed.
  const email = invitation.identity.trim().toLowerCase()

  if (await emailExists(c, email)) throw emailTaken()

  const db = getDb(c.env)
  try {
    await acrossTheDrop((withPasswordColumns) =>
      db.batch([
        insertUser(db, withPasswordColumns, {
          id: crypto.randomUUID(),
          organizationId: invitation.organizationId,
          name: input.name,
          email,
          emailVerified: true,
          role: 'agent',
          status: 'active',
          plan: 'free',
        }),
        db
          .update(invitations)
          .set({ status: 'accepted', updatedAt: new Date() })
          .where(and(eq(invitations.id, invitation.id), eq(invitations.status, 'pending'))),
      ]),
    )
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken()
    throw err
  }

  await sendSignInCode(c, email)

  return c.json({ email }, 200)
}
