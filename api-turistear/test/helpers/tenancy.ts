import { env } from 'cloudflare:test'

// Shared multitenancy test helpers.
//
// Every NEW tenant-scoped resource route (services, slots, folios, …) MUST add,
// in its own test suite, two isolation tests built on `seedTwoOrgs`:
//   • B3 — fetch-by-id of org A's row as org B's admin → 404 (no leakage)
//   • B4 — collection/list as org B's admin → org A's rows never appear
// See docs/multitenancy/multitenancy.spec.md (Scenarios B3, B4).

const DEFAULT_ORG_NAME = 'Empresa S.A.'

interface SeedUserOptions {
  email: string
  name?: string
  role?: 'admin' | 'agent' | 'affiliate'
  status?: 'unverified' | 'active' | 'suspended'
  /** Agent base commission as a whole-number percentage (default 0). */
  baseCommission?: number
  /** Reuse an existing org instead of creating a new one. */
  organizationId?: string
  organizationName?: string
  /** Link an `affiliate` user to its company (affiliate-setup-commissions.spec.md D4). */
  affiliateCompanyId?: string
}

export const seedUser = async ({
  email,
  name = 'Test User',
  role = 'admin',
  status = 'active',
  baseCommission = 0,
  organizationId,
  organizationName = DEFAULT_ORG_NAME,
  affiliateCompanyId,
}: SeedUserOptions): Promise<{ userId: string; organizationId: string }> => {
  const orgId = organizationId ?? crypto.randomUUID()
  const userId = crypto.randomUUID()

  if (!organizationId) {
    // US-A66 — seed test orgs in UTC so the suite's frozen UTC clock IS the org-local clock. The
    // whole suite reasons in naive-UTC wall-clock (slot times chosen against the frozen 12:00Z);
    // the production default is 'America/Mexico_City' (asserted separately in the organizations
    // suite, which seeds `timezone` explicitly). The tz-conversion math is covered by
    // test/pos/timezone.test.ts.
    await env.DB.prepare('INSERT INTO organizations (id, name, timezone) VALUES (?, ?, ?)')
      .bind(orgId, organizationName, 'UTC')
      .run()
  }

  await env.DB.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, phone, role, status, base_commission, plan, affiliate_company_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      orgId,
      name,
      email,
      'STORED_HASH',
      'STORED_SALT',
      '+52 55 1234 5678',
      role,
      status,
      baseCommission,
      'free',
      affiliateCompanyId ?? null,
    )
    .run()

  return { userId, organizationId: orgId }
}

/** Seeds an affiliate company (the partner) in the given org. */
export const seedAffiliateCompany = async ({
  organizationId,
  name = 'Hotel Maya',
  status = 'active',
}: {
  organizationId: string
  name?: string
  status?: 'active' | 'suspended'
}): Promise<{ companyId: string }> => {
  const companyId = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO affiliate_companies (id, organization_id, name, status) VALUES (?, ?, ?, ?)',
  )
    .bind(companyId, organizationId, name, status)
    .run()
  return { companyId }
}

/** Seeds one allow-list row (enables a service for an affiliate at a rate). */
export const seedAffiliateCommission = async ({
  organizationId,
  affiliateCompanyId,
  serviceId,
  commissionType = 'percent',
  commissionValue = 1500,
}: {
  organizationId: string
  affiliateCompanyId: string
  serviceId: string
  commissionType?: 'percent' | 'fixed'
  commissionValue?: number
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO affiliate_commissions (id, organization_id, affiliate_company_id, service_id, commission_type, commission_value)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      organizationId,
      affiliateCompanyId,
      serviceId,
      commissionType,
      commissionValue,
    )
    .run()
}

export const clearTenancyDb = async () => {
  // FK-safe order: drop the affiliate child rows before the companies they reference, and the
  // companies before the organizations + after the users that link to them.
  await env.DB.exec('DELETE FROM affiliate_commissions')
  await env.DB.exec('DELETE FROM affiliate_invitations')
  await env.DB.exec('DELETE FROM invitations')
  await env.DB.exec('DELETE FROM users')
  await env.DB.exec('DELETE FROM affiliate_companies')
  await env.DB.exec('DELETE FROM organizations')
}

/**
 * Full FK-safe wipe for suites that also seed services / slots / folios / cash drops alongside
 * affiliates. Deletes every dependent table before the organizations they reference.
 */
export const clearAffiliateDb = async () => {
  for (const table of [
    'cash_drops',
    'payouts',
    'agent_expenses',
    'folio_line_extras',
    'folio_lines',
    'folio_access_tokens',
    'cancellation_requests',
    'folios',
    'affiliate_commissions',
    'affiliate_invitations',
    'slots',
    'schedules',
    'service_extras',
    'services',
    'invitations',
    'password_reset_tokens',
    'users',
    'affiliate_companies',
    'organizations',
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`)
  }
}

export interface SeededOrg {
  organizationId: string
  adminUserId: string
  adminEmail: string
  organizationName: string
}

/**
 * Seeds two fully isolated organizations, each with an active admin.
 * Use the returned `adminEmail` with `buildFakeJwt(email)` to authenticate as
 * either org's admin in a cross-org isolation test.
 */
export const seedTwoOrgs = async (): Promise<{
  orgA: SeededOrg
  orgB: SeededOrg
}> => {
  const adminAEmail = 'admin-a@empresa.com'
  const adminBEmail = 'admin-b@empresa.com'

  const a = await seedUser({
    email: adminAEmail,
    role: 'admin',
    organizationName: 'Org A',
  })
  const b = await seedUser({
    email: adminBEmail,
    role: 'admin',
    organizationName: 'Org B',
  })

  return {
    orgA: {
      organizationId: a.organizationId,
      adminUserId: a.userId,
      adminEmail: adminAEmail,
      organizationName: 'Org A',
    },
    orgB: {
      organizationId: b.organizationId,
      adminUserId: b.userId,
      adminEmail: adminBEmail,
      organizationName: 'Org B',
    },
  }
}
