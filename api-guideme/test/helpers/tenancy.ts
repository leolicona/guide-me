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
  role?: 'admin' | 'agent'
  status?: 'unverified' | 'active' | 'suspended'
  /** Agent base commission as a whole-number percentage (default 0). */
  baseCommission?: number
  /** Reuse an existing org instead of creating a new one. */
  organizationId?: string
  organizationName?: string
}

export const seedUser = async ({
  email,
  name = 'Test User',
  role = 'admin',
  status = 'active',
  baseCommission = 0,
  organizationId,
  organizationName = DEFAULT_ORG_NAME,
}: SeedUserOptions): Promise<{ userId: string; organizationId: string }> => {
  const orgId = organizationId ?? crypto.randomUUID()
  const userId = crypto.randomUUID()

  if (!organizationId) {
    await env.DB.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)')
      .bind(orgId, organizationName)
      .run()
  }

  await env.DB.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, phone, role, status, base_commission, plan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run()

  return { userId, organizationId: orgId }
}

export const clearTenancyDb = async () => {
  await env.DB.exec('DELETE FROM invitations')
  await env.DB.exec('DELETE FROM users')
  await env.DB.exec('DELETE FROM organizations')
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
