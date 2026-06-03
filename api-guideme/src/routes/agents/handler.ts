import type { Context } from 'hono'
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { invitations, organizations, users } from '../../db/schema'
import { sendInvitationEmail } from '../../services/resend'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type { InviteAgentInput, UpdateAgentInput } from './schema'

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

  const inviteLink = `${c.env.APP_BASE_URL}/invite/accept?token=${token}`

  await sendInvitationEmail(c.env, {
    to: input.identity,
    organizationName,
    inviteLink,
  })

  return c.json({ message: 'Invitación enviada.' }, 201)
}

// Maps a users row to the public agent shape. password_hash / password_salt are
// never selected, so they can never leak into a response.
interface AgentRow {
  id: string
  name: string
  email: string
  phone: string | null
  status: string
  baseCommission: number
}

const serializeAgent = (row: AgentRow) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  status: row.status,
  base_commission: row.baseCommission,
})

const agentColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  phone: users.phone,
  status: users.status,
  baseCommission: users.baseCommission,
} as const

// US-A06 — list every agent in the caller's org (active + suspended).
export const listAgents = async (c: AgentsContext) => {
  const admin = c.get('user')
  const db = getDb(c.env)

  const rows = await db
    .select(agentColumns)
    .from(users)
    .where(
      and(
        eq(users.organizationId, admin.organizationId),
        eq(users.role, 'agent'),
      ),
    )
    .orderBy(asc(users.name))

  return c.json({ agents: rows.map(serializeAgent) })
}

// US-A07 — edit an agent's profile and base commission.
export const updateAgent = async (c: AgentsContext) => {
  const admin = c.get('user')
  const id = c.req.param('id')
  const input = (await c.req.json()) as UpdateAgentInput
  const db = getDb(c.env)

  const result = await db
    .update(users)
    .set({
      name: input.name,
      phone: input.phone ?? null,
      baseCommission: input.base_commission,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(users.id, id),
        eq(users.organizationId, admin.organizationId),
        eq(users.role, 'agent'),
      ),
    )
    .returning(agentColumns)

  const agent = result[0]
  if (!agent) {
    throw new ApiError('NOT_FOUND', 404, 'Agent not found')
  }

  return c.json({ agent: serializeAgent(agent) })
}

// US-A08 — deactivate / reactivate. The org + role filter is what makes an
// unknown id, a foreign-org user, or an admin resolve to 404 (0 rows matched).
const setAgentStatus = async (
  c: AgentsContext,
  status: 'suspended' | 'active',
) => {
  const admin = c.get('user')
  const id = c.req.param('id')
  const db = getDb(c.env)

  const result = await db
    .update(users)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(users.id, id),
        eq(users.organizationId, admin.organizationId),
        eq(users.role, 'agent'),
      ),
    )
    .returning({ id: users.id, name: users.name, status: users.status })

  const agent = result[0]
  if (!agent) {
    throw new ApiError('NOT_FOUND', 404, 'Agent not found')
  }

  return c.json({ agent })
}

export const deactivateAgent = (c: AgentsContext) =>
  setAgentStatus(c, 'suspended')

export const reactivateAgent = (c: AgentsContext) => setAgentStatus(c, 'active')
