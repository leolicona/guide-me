import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Service Categories & POS Catalog Filtering (US-A37).
// Spec: docs/catalog/service-categories.spec.md (Scenarios 1–11).
//
// Covers: the required category field on the admin catalog form (create/edit),
// rejection of missing/unknown values, round-trip through the catalog detail read,
// pre-migration (null) rows, the category exposed on the POS catalog payload, and
// multitenancy (B1/B4) via seedTwoOrgs. Scenarios 7–9 (filter-chip rendering) are
// frontend behaviours, asserted in the app build, not here.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

// --- Local seeders (raw D1) ------------------------------------------------

interface SeedServiceOptions {
  organizationId: string
  name?: string
  /** undefined → omit the column entirely (a pre-migration / legacy NULL row). */
  category?: 'lodging' | 'tours' | 'dining' | 'adventure' | 'culture'
  status?: 'active' | 'inactive'
}

const seedService = async ({
  organizationId,
  name = 'City Tour',
  category,
  status = 'active',
}: SeedServiceOptions): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        commission_type, commission_value, is_flexible, flex_capacity_pct, category, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 150000, 100000, 12, 'percent', 0, 0, 0, ?, ?, ?, ?)`,
  )
    .bind(serviceId, organizationId, name, category ?? null, status, ts, ts)
    .run()
  return { serviceId }
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  date = '2026-06-15',
): Promise<{ slotId: string }> => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, date, ts, ts)
    .run()
  return { slotId }
}

const getCategory = async (id: string) => {
  const r = await env.DB.prepare(`SELECT category FROM services WHERE id = ?`)
    .bind(id)
    .first<{ category: string | null }>()
  return r?.category ?? null
}

const countServices = async () => {
  const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM services').first<{
    c: number
  }>()
  return r?.c ?? 0
}

const clearCatalogDb = async () => {
  await env.DB.exec('DELETE FROM cancellation_requests')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

const SERVICES = 'http://api.local/api/services'
const POS = 'http://api.local/api/pos'

const createService = (body: Record<string, unknown>) =>
  SELF.fetch(SERVICES, {
    method: 'POST',
    headers: jsonAuth(ADMIN_EMAIL),
    body: JSON.stringify({
      name: 'Canyon Tour',
      base_price: 150000,
      minimum_price: 100000,
      default_capacity: 12,
      ...body,
    }),
  })

beforeEach(async () => {
  await clearCatalogDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
// US-A37 — admin assigns a category (POST/PUT /api/services)
// ---------------------------------------------------------------------------
describe('US-A37 — assign a service category', () => {
  it('Scenario 1 — category persists on create and is echoed', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await createService({ category: 'tours' })
    expect(res.status).toBe(201)
    const { service } = (await res.json()) as { service: any }
    expect(service.category).toBe('tours')
    expect(await getCategory(service.id)).toBe('tours')
  })

  it('Scenario 2 — category is required (omitted / null / empty → 400, no row)', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const bad = [{}, { category: null }, { category: '' }]
    for (const payload of bad) {
      const res = await createService(payload)
      expect(res.status, JSON.stringify(payload)).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    }
    expect(await countServices()).toBe(0)
  })

  it('Scenario 3 — an unknown category is rejected (400, no row)', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await createService({ category: 'spa' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    expect(await countServices()).toBe(0)
  })

  it('Scenario 4 — category round-trips through detail and is replaced on edit', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const created = await createService({ category: 'dining' })
    const { service } = (await created.json()) as { service: any }

    const detail = await SELF.fetch(`${SERVICES}/${service.id}`, {
      headers: auth(ADMIN_EMAIL),
    })
    expect(((await detail.json()) as any).service.category).toBe('dining')

    const put = await SELF.fetch(`${SERVICES}/${service.id}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'Canyon Tour',
        base_price: 150000,
        minimum_price: 100000,
        default_capacity: 12,
        category: 'culture',
      }),
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as any).service.category).toBe('culture')
    expect(await getCategory(service.id)).toBe('culture')
  })

  it('Scenario 5 — a legacy (null) service reads null and is forced to choose on edit', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { serviceId } = await seedService({ organizationId }) // no category → NULL

    const detail = await SELF.fetch(`${SERVICES}/${serviceId}`, {
      headers: auth(ADMIN_EMAIL),
    })
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as any).service.category).toBeNull()

    // A PUT without a category is rejected — the required rule applies to every write.
    const put = await SELF.fetch(`${SERVICES}/${serviceId}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'City Tour',
        base_price: 150000,
        minimum_price: 100000,
        default_capacity: 12,
      }),
    })
    expect(put.status).toBe(400)
    expect(((await put.json()) as any).error.code).toBe('VALIDATION_ERROR')
    expect(await getCategory(serviceId)).toBeNull() // unchanged
  })
})

// ---------------------------------------------------------------------------
// US-A37 — category on the POS catalog payload
// ---------------------------------------------------------------------------
describe('US-A37 — POS catalog exposes category', () => {
  it('Scenario 6 — the POS catalog item includes category', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({
      organizationId,
      name: 'Canyon Tour',
      category: 'tours',
    })
    await seedSlot(organizationId, serviceId)

    const res = await SELF.fetch(`${POS}/services?today=2026-06-01`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(res.status).toBe(200)
    const { services } = (await res.json()) as { services: any[] }
    expect(services[0]).toMatchObject({ name: 'Canyon Tour', category: 'tours' })
  })

  it('a legacy (null) service exposes category: null on the POS catalog', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, name: 'Old Tour' })
    await seedSlot(organizationId, serviceId)

    const res = await SELF.fetch(`${POS}/services?today=2026-06-01`, {
      headers: auth(AGENT_EMAIL),
    })
    const { services } = (await res.json()) as { services: any[] }
    expect(services[0].category).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation (required — Scenarios B1 / B4, seedTwoOrgs)
// ---------------------------------------------------------------------------
describe('US-A37 — multitenancy isolation', () => {
  it('Scenario 10 — B1: injected organizationId is stripped; category persists', async () => {
    const { orgA, orgB } = await seedTwoOrgs()

    const res = await SELF.fetch(SERVICES, {
      method: 'POST',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        name: 'Canyon Tour',
        base_price: 150000,
        minimum_price: 100000,
        default_capacity: 12,
        category: 'tours',
        organizationId: orgB.organizationId, // injected — must be ignored
      }),
    })
    expect(res.status).toBe(201)
    const { service } = (await res.json()) as { service: any }
    expect(service.category).toBe('tours')

    const row = await env.DB.prepare(
      `SELECT organization_id, category FROM services WHERE id = ?`,
    )
      .bind(service.id)
      .first<{ organization_id: string; category: string }>()
    expect(row).toMatchObject({
      organization_id: orgA.organizationId,
      category: 'tours',
    })
  })

  it("Scenario 11 — B4: the POS catalog (and its categories) is scoped to the caller's org", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      organizationId: orgA.organizationId,
    })
    const a = await seedService({
      organizationId: orgA.organizationId,
      name: 'A Tour',
      category: 'tours',
    })
    await seedSlot(orgA.organizationId, a.serviceId)
    const b = await seedService({
      organizationId: orgB.organizationId,
      name: 'B Dining',
      category: 'dining',
    })
    await seedSlot(orgB.organizationId, b.serviceId)

    const res = await SELF.fetch(`${POS}/services?today=2026-06-01`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(res.status).toBe(200)
    const { services } = (await res.json()) as { services: any[] }
    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({ name: 'A Tour', category: 'tours' })
    // org B's dining service (and its category) never appears for org A.
    expect(services.some((s) => s.category === 'dining')).toBe(false)
  })
})
