import type { Context } from 'hono'
import type { BatchItem } from 'drizzle-orm/batch'
import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  affiliateCommissions,
  affiliateCompanies,
  affiliateInvitations,
  cashDrops,
  folios,
  organizations,
  services,
  users,
} from '../../db/schema'
import { sendAffiliateInvitationEmail } from '../../services/resend'
import { ApiError } from '../../types/errors'
import type { AppVariables } from '../../types/context'
import type {
  CommissionEntry,
  CreateAffiliateInput,
  InviteAffiliateInput,
  UpdateAffiliateInput,
} from './schema'

type AffiliatesContext = Context<{
  Bindings: CloudflareBindings
  Variables: AppVariables
}>

const INVITATION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

// One-manager invariant (docs/affiliate-operators/spec.md, D13): a company has AT MOST ONE
// credentialed `affiliate` seat — the manager / "Hotel Cashier". Additional sellers are modeled as
// PIN operators (US-AF10), not extra logins, so the hotel keeps a single caja (US-A68). A "seat" is
// an accepted affiliate user OR a still-pending invitation. Throws 409 when one already exists.
const assertNoManagerSeat = async (
  db: ReturnType<typeof getDb>,
  companyId: string,
): Promise<void> => {
  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.affiliateCompanyId, companyId), eq(users.role, 'affiliate')))
    .limit(1)
  const pendingInvite = await db
    .select({ id: affiliateInvitations.id })
    .from(affiliateInvitations)
    .where(
      and(
        eq(affiliateInvitations.affiliateCompanyId, companyId),
        eq(affiliateInvitations.status, 'pending'),
      ),
    )
    .limit(1)
  if (existingUser.length > 0 || pendingInvite.length > 0) {
    throw new ApiError(
      'AFFILIATE_MANAGER_EXISTS',
      409,
      'La empresa ya tiene un gerente. Los vendedores adicionales se agregan como operadores.',
    )
  }
}

// Validate an allow-list set (D2/D10) against the caller's org. Every service must exist, be in
// THIS org, and be active (a cross-org or inactive service id is rejected). A `fixed` rate may
// not exceed the service's minimum_price. Returns nothing; throws on the first offender.
const validateCommissions = async (
  c: AffiliatesContext,
  entries: CommissionEntry[],
) => {
  if (entries.length === 0) return
  const org = c.get('user').organizationId
  const db = getDb(c.env)

  const ids = [...new Set(entries.map((e) => e.service_id))]
  const rows = await db
    .select({
      id: services.id,
      minimumPrice: services.minimumPrice,
      status: services.status,
    })
    .from(services)
    .where(and(eq(services.organizationId, org), inArray(services.id, ids)))

  const byId = new Map(rows.map((r) => [r.id, r]))

  for (const entry of entries) {
    const svc = byId.get(entry.service_id)
    // Unknown OR foreign-org service → 404 (cross-org enable is rejected, B-isolation).
    if (!svc) {
      throw new ApiError('NOT_FOUND', 404, 'Service not found')
    }
    if (svc.status !== 'active') {
      throw new ApiError(
        'SERVICE_INACTIVE',
        409,
        'Cannot enable an inactive service for an affiliate',
      )
    }
    // D10 — a fixed commission may never exceed the floor-priced pass revenue.
    if (entry.commission_type === 'fixed' && entry.commission_value > svc.minimumPrice) {
      throw new ApiError(
        'VALIDATION_ERROR',
        400,
        'Fixed commission may not exceed the service minimum price',
      )
    }
  }
}

// Resolve a company id IN THE CALLER'S ORG or throw 404. The org filter is what makes a foreign
// or unknown id resolve to 404 (B3 cross-org isolation).
const requireCompany = async (c: AffiliatesContext, id: string) => {
  const org = c.get('user').organizationId
  const db = getDb(c.env)
  const rows = await db
    .select({ id: affiliateCompanies.id, name: affiliateCompanies.name })
    .from(affiliateCompanies)
    .where(and(eq(affiliateCompanies.id, id), eq(affiliateCompanies.organizationId, org)))
    .limit(1)
  const company = rows[0]
  if (!company) {
    throw new ApiError('NOT_FOUND', 404, 'Affiliate not found')
  }
  return company
}

// US-A54–A57 (D9) — wizard finalize. Validate EVERYTHING first (fail-all), then write company +
// all commission rows + invitation records in one atomic batch. Resend emails are dispatched
// AFTER the commit so a mail hiccup never leaves a half-saved affiliate (the row persists as a
// resend-able pending invitation).
export const createAffiliate = async (c: AffiliatesContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const db = getDb(c.env)
  const input = c.req.valid('json') as CreateAffiliateInput

  const commissions = input.commissions
  const inviteEmails = [...new Set(input.invites.map((e) => e.toLowerCase()))]

  await validateCommissions(c, commissions)

  const companyId = crypto.randomUUID()
  const now = new Date()
  const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000)

  const invites = inviteEmails.map((email) => ({
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    email,
  }))

  const statements: BatchItem<'sqlite'>[] = [
    db.insert(affiliateCompanies).values({
      id: companyId,
      organizationId: org,
      name: input.company.name.trim(),
      contactEmail: input.company.contact_email ?? null,
      contactPhone: input.company.contact_phone ?? null,
      status: 'active',
    }),
  ]

  for (const entry of commissions) {
    statements.push(
      db.insert(affiliateCommissions).values({
        id: crypto.randomUUID(),
        organizationId: org,
        affiliateCompanyId: companyId,
        serviceId: entry.service_id,
        commissionType: entry.commission_type,
        commissionValue: entry.commission_value,
      }),
    )
  }

  for (const inv of invites) {
    statements.push(
      db.insert(affiliateInvitations).values({
        id: inv.id,
        organizationId: org,
        affiliateCompanyId: companyId,
        identity: inv.email,
        identityType: 'email',
        token: inv.token,
        invitedBy: admin.userId,
        status: 'pending',
        expiresAt,
      }),
    )
  }

  // D1 batch is atomic — any failed insert rolls back the whole company (fail-all).
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

  // Emails AFTER commit (best-effort; a failed send leaves a resend-able pending invite).
  if (invites.length > 0) {
    const orgRows = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, org))
      .limit(1)
    const organizationName = orgRows[0]?.name ?? ''
    await Promise.allSettled(
      invites.map((inv) =>
        sendAffiliateInvitationEmail(c.env, {
          to: inv.email,
          organizationName,
          companyName: input.company.name.trim(),
          inviteLink: `${c.env.APP_BASE_URL}/invite/accept?token=${inv.token}`,
        }),
      ),
    )
  }

  return c.json(
    {
      affiliate: {
        id: companyId,
        name: input.company.name.trim(),
        status: 'active',
        service_count: commissions.length,
        user_count: 0,
        pending_invite_count: invites.length,
      },
    },
    201,
  )
}

// US-A48 — list every affiliate company in the caller's org with its #services + #users.
export const listAffiliates = async (c: AffiliatesContext) => {
  const org = c.get('user').organizationId
  const db = getDb(c.env)

  const companies = await db
    .select({
      id: affiliateCompanies.id,
      name: affiliateCompanies.name,
      contactEmail: affiliateCompanies.contactEmail,
      contactPhone: affiliateCompanies.contactPhone,
      status: affiliateCompanies.status,
    })
    .from(affiliateCompanies)
    .where(eq(affiliateCompanies.organizationId, org))
    .orderBy(asc(affiliateCompanies.name))

  const serviceCounts = await db
    .select({
      companyId: affiliateCommissions.affiliateCompanyId,
      n: sql<number>`count(*)`,
    })
    .from(affiliateCommissions)
    .where(eq(affiliateCommissions.organizationId, org))
    .groupBy(affiliateCommissions.affiliateCompanyId)
  const serviceCountBy = new Map(serviceCounts.map((r) => [r.companyId, Number(r.n)]))

  const userCounts = await db
    .select({
      companyId: users.affiliateCompanyId,
      n: sql<number>`count(*)`,
    })
    .from(users)
    .where(and(eq(users.organizationId, org), eq(users.role, 'affiliate')))
    .groupBy(users.affiliateCompanyId)
  const userCountBy = new Map(userCounts.map((r) => [r.companyId, Number(r.n)]))

  return c.json({
    affiliates: companies.map((co) => ({
      id: co.id,
      name: co.name,
      contact_email: co.contactEmail,
      contact_phone: co.contactPhone,
      status: co.status,
      service_count: serviceCountBy.get(co.id) ?? 0,
      user_count: userCountBy.get(co.id) ?? 0,
    })),
  })
}

// US-A48 — one affiliate: company + commissions (joined to services for the display name) +
// users + pending invitations.
export const getAffiliate = async (c: AffiliatesContext) => {
  const org = c.get('user').organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)

  const rows = await db
    .select()
    .from(affiliateCompanies)
    .where(and(eq(affiliateCompanies.id, id), eq(affiliateCompanies.organizationId, org)))
    .limit(1)
  const company = rows[0]
  if (!company) {
    throw new ApiError('NOT_FOUND', 404, 'Affiliate not found')
  }

  const commissions = await db
    .select({
      service_id: affiliateCommissions.serviceId,
      service_name: services.name,
      service_status: services.status,
      commission_type: affiliateCommissions.commissionType,
      commission_value: affiliateCommissions.commissionValue,
    })
    .from(affiliateCommissions)
    .innerJoin(services, eq(affiliateCommissions.serviceId, services.id))
    .where(
      and(
        eq(affiliateCommissions.organizationId, org),
        eq(affiliateCommissions.affiliateCompanyId, id),
      ),
    )
    .orderBy(asc(services.name))

  const companyUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      position: users.position,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.organizationId, org), eq(users.affiliateCompanyId, id)))
    .orderBy(asc(users.name))

  const pending = await db
    .select({
      id: affiliateInvitations.id,
      identity: affiliateInvitations.identity,
      created_at: affiliateInvitations.createdAt,
    })
    .from(affiliateInvitations)
    .where(
      and(
        eq(affiliateInvitations.affiliateCompanyId, id),
        eq(affiliateInvitations.status, 'pending'),
      ),
    )

  return c.json({
    affiliate: {
      id: company.id,
      name: company.name,
      contact_email: company.contactEmail,
      contact_phone: company.contactPhone,
      status: company.status,
      commissions,
      users: companyUsers,
      pending_invites: pending,
    },
  })
}

// US-A48 — edit company profile fields (D11). The org filter makes a foreign id resolve to 404.
export const updateAffiliate = async (c: AffiliatesContext) => {
  const org = c.get('user').organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)
  const input = c.req.valid('json') as UpdateAffiliateInput

  const result = await db
    .update(affiliateCompanies)
    .set({
      name: input.name.trim(),
      contactEmail: input.contact_email ?? null,
      contactPhone: input.contact_phone ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(affiliateCompanies.id, id), eq(affiliateCompanies.organizationId, org)))
    .returning({ id: affiliateCompanies.id })

  if (result.length === 0) {
    throw new ApiError('NOT_FOUND', 404, 'Affiliate not found')
  }
  return c.json({ ok: true })
}

// US-A50 — bulk upsert the allow-list: the array is the full desired set, so the operation is
// DELETE-all-then-INSERT (a service absent from the array is disabled, D1). Atomic via batch.
export const setAffiliateCommissions = async (c: AffiliatesContext) => {
  const org = c.get('user').organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)
  const entries = c.req.valid('json') as CommissionEntry[]

  await requireCompany(c, id)
  await validateCommissions(c, entries)

  const statements: BatchItem<'sqlite'>[] = [
    db
      .delete(affiliateCommissions)
      .where(
        and(
          eq(affiliateCommissions.organizationId, org),
          eq(affiliateCommissions.affiliateCompanyId, id),
        ),
      ),
  ]
  for (const entry of entries) {
    statements.push(
      db.insert(affiliateCommissions).values({
        id: crypto.randomUUID(),
        organizationId: org,
        affiliateCompanyId: id,
        serviceId: entry.service_id,
        commissionType: entry.commission_type,
        commissionValue: entry.commission_value,
      }),
    )
  }

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  return c.json({ ok: true, service_count: entries.length })
}

// US-A49 — invite a login for an existing affiliate company (parallel flow, D8). Blocks a second
// pending invite for the same email+company, and an email that is already a user.
export const inviteAffiliate = async (c: AffiliatesContext) => {
  const admin = c.get('user')
  const org = admin.organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)
  const input = c.req.valid('json') as InviteAffiliateInput
  const email = input.email.toLowerCase()

  const company = await requireCompany(c, id)

  // D13 — at most one credentialed affiliate (the manager) per company; extra sellers are operators.
  await assertNoManagerSeat(db, id)

  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  if (existingUser.length > 0) {
    throw new ApiError('IDENTITY_ALREADY_EXISTS', 409, 'A user with this email already exists')
  }

  const token = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000)

  await db.insert(affiliateInvitations).values({
    id: crypto.randomUUID(),
    organizationId: org,
    affiliateCompanyId: id,
    identity: email,
    identityType: 'email',
    token,
    invitedBy: admin.userId,
    status: 'pending',
    expiresAt,
  })

  const orgRows = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, org))
    .limit(1)

  await sendAffiliateInvitationEmail(c.env, {
    to: email,
    organizationName: orgRows[0]?.name ?? '',
    companyName: company.name,
    inviteLink: `${c.env.APP_BASE_URL}/invite/accept?token=${token}`,
  })

  return c.json({ message: 'Invitación enviada.' }, 201)
}

// US-A52 — suspend / reactivate. Suspending cascades the status to the company's affiliate users
// (authMiddleware already 403s a suspended user — no new sales/logins) while leaving existing
// folios/QRs intact (D7). One atomic batch.
const setAffiliateStatus = async (
  c: AffiliatesContext,
  status: 'active' | 'suspended',
) => {
  const org = c.get('user').organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)

  await requireCompany(c, id)

  // Cascade to the company's users: suspend → suspend; reactivate → restore to active. We never
  // touch an 'unverified' user (they have no session to block) — only active/suspended flip.
  const userTarget = status === 'suspended' ? 'suspended' : 'active'
  const userFrom = status === 'suspended' ? 'active' : 'suspended'

  await db.batch([
    db
      .update(affiliateCompanies)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(affiliateCompanies.id, id), eq(affiliateCompanies.organizationId, org))),
    db
      .update(users)
      .set({ status: userTarget, updatedAt: new Date() })
      .where(
        and(
          eq(users.organizationId, org),
          eq(users.affiliateCompanyId, id),
          eq(users.status, userFrom),
        ),
      ),
  ])

  return c.json({ ok: true, status })
}

export const deactivateAffiliate = (c: AffiliatesContext) => setAffiliateStatus(c, 'suspended')
export const reactivateAffiliate = (c: AffiliatesContext) => setAffiliateStatus(c, 'active')

// US-A53 — settlement report over an optional [from, to] range. Cash owed = cash collected −
// commission earned − confirmed deposits (the agent model, D6; affiliates have no expenses).
export const getAffiliateReport = async (c: AffiliatesContext) => {
  const org = c.get('user').organizationId
  const id = c.req.param('id')
  const db = getDb(c.env)
  const { from, to } = c.req.valid('query') as { from?: string; to?: string }

  await requireCompany(c, id)

  // Date bounds (createdAt is a unix-epoch integer). `from`/`to` are 'YYYY-MM-DD'.
  const fromTs = from ? new Date(`${from}T00:00:00Z`) : null
  const toTs = to ? new Date(`${to}T23:59:59Z`) : null
  const folioRange = [
    eq(folios.organizationId, org),
    eq(folios.affiliateCompanyId, id),
    ne(folios.status, 'cancelled'),
    ...(fromTs ? [gte(folios.createdAt, fromTs)] : []),
    ...(toTs ? [lte(folios.createdAt, toTs)] : []),
  ]

  const totals = await db
    .select({
      sales: sql<number>`coalesce(sum(${folios.amountPaid}), 0)`,
      commission: sql<number>`coalesce(sum(${folios.commissionAmount}), 0)`,
      cashCollected: sql<number>`coalesce(sum(case when ${folios.paymentMethod} = 'cash' then ${folios.amountPaid} else 0 end), 0)`,
    })
    .from(folios)
    .where(and(...folioRange))

  const sales = Number(totals[0]?.sales ?? 0)
  const commission = Number(totals[0]?.commission ?? 0)
  const cashCollected = Number(totals[0]?.cashCollected ?? 0)

  // Confirmed deposits handed in by THIS company's affiliate users over the range.
  const affiliateUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organizationId, org), eq(users.affiliateCompanyId, id)))
  const userIds = affiliateUsers.map((u) => u.id)

  let deposits = 0
  if (userIds.length > 0) {
    const dropTotals = await db
      .select({ deposits: sql<number>`coalesce(sum(${cashDrops.amount}), 0)` })
      .from(cashDrops)
      .where(
        and(
          eq(cashDrops.organizationId, org),
          inArray(cashDrops.agentId, userIds),
          eq(cashDrops.status, 'confirmed'),
          ...(fromTs ? [gte(cashDrops.createdAt, fromTs)] : []),
          ...(toTs ? [lte(cashDrops.createdAt, toTs)] : []),
        ),
      )
    deposits = Number(dropTotals[0]?.deposits ?? 0)
  }

  return c.json({
    report: {
      sales_total: sales,
      commission_total: commission,
      cash_collected: cashCollected,
      deposits_total: deposits,
      cash_owed: cashCollected - commission - deposits,
    },
  })
}
