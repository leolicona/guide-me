import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { invitations, organizations, users } from '../../db/schema'
import { sendInvitationEmail } from '../../services/resend'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type { InviteAgentInput } from './schema'

type AgentsContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

const INVITATION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

export const inviteAgent = async (c: AgentsContext) => {
  const input = (await c.req.json()) as InviteAgentInput
  const admin = c.get('user')
  const db = getDb(c.env)

  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.identity))
    .limit(1)

  if (existingUser.length > 0) {
    throw new ApiError(
      'IDENTITY_ALREADY_EXISTS',
      409,
      'A user with this identity already exists',
    )
  }

  await db
    .update(invitations)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(invitations.identity, input.identity),
        eq(invitations.status, 'pending'),
      ),
    )

  const org = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, admin.organizationId))
    .limit(1)

  const organizationName = org[0]?.name ?? ''

  const token = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000)

  await db.insert(invitations).values({
    id: crypto.randomUUID(),
    organizationId: admin.organizationId,
    identity: input.identity,
    identityType: 'email',
    token,
    invitedBy: admin.userId,
    status: 'pending',
    expiresAt,
  })

  const inviteLink = `${c.env.API_BASE_URL}/api/auth/invite/accept?token=${token}`

  await sendInvitationEmail(c.env, {
    to: input.identity,
    organizationName,
    inviteLink,
  })

  return c.json({ message: 'Invitación enviada.' }, 201)
}
