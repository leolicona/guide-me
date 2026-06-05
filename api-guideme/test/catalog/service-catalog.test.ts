import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Service Catalog — services CRUD with a minimum-price floor + soft
// deactivation, plus nested extras CRUD.
// Spec: docs/catalog/service-catalog.spec.md (Scenarios 1–18).
// Multitenancy isolation (16–18) uses the shared `seedTwoOrgs` helper, per
// docs/multitenancy/multitenancy.spec.md (B4, B3, B1) and CLAUDE.md.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

// --- Local seeders (raw D1, mirroring seedUser) ---------------------------

interface SeedServiceOptions {
  organizationId: string
  name?: string
  description?: string | null
  basePrice?: number
  minimumPrice?: number
  defaultCapacity?: number
  commissionBonus?: number
  status?: 'active' | 'inactive'
  /** Override updated_at (unix seconds) — used to assert it advances on edit. */
  updatedAt?: number
}

const seedService = async ({
  organizationId,
  name = 'City Tour',
  description = null,
  basePrice = 150000,
  minimumPrice = 100000,
  defaultCapacity = 10,
  commissionBonus = 0,
  status = 'active',
  updatedAt,
}: SeedServiceOptions): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = updatedAt ?? Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_bonus, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      serviceId,
      organizationId,
      name,
      description,
      basePrice,
      minimumPrice,
      defaultCapacity,
      commissionBonus,
      status,
      ts,
      ts,
    )
    .run()
  return { serviceId }
}

interface SeedExtraOptions {
  organizationId: string
  serviceId: string
  name?: string
  price?: number
  status?: 'active' | 'inactive'
}

const seedExtra = async ({
  organizationId,
  serviceId,
  name = 'Lunch',
  price = 5000,
  status = 'active',
}: SeedExtraOptions): Promise<{ extraId: string }> => {
  const extraId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO service_extras
       (id, organization_id, service_id, name, price, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(extraId, organizationId, serviceId, name, price, status)
    .run()
  return { extraId }
}

// --- After-state readers (bypass the API) ---------------------------------

const getServiceRow = (id: string) =>
  env.DB.prepare(
    `SELECT id, organization_id, name, description, base_price, minimum_price,
            default_capacity, commission_bonus, status, updated_at
       FROM services WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string
      organization_id: string
      name: string
      description: string | null
      base_price: number
      minimum_price: number
      default_capacity: number
      commission_bonus: number
      status: string
      updated_at: number
    }>()

const getExtraRow = (id: string) =>
  env.DB.prepare(
    `SELECT id, organization_id, service_id, name, price, status
       FROM service_extras WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string
      organization_id: string
      service_id: string
      name: string
      price: number
      status: string
    }>()

const countServices = async () => {
  const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM services').first<{
    c: number
  }>()
  return r?.c ?? 0
}

// services / service_extras reference organizations, so clear children first. Folios
// (sold in the commission-snapshot test) reference users/services — clear them too so the
// tenancy clear can drop users.
const clearCatalogDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearCatalogDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
// US-A09 — POST /api/services
// ---------------------------------------------------------------------------
describe('US-A09 — create service (POST /api/services)', () => {
  it('Scenario 1 — creates an active service with empty extras', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await SELF.fetch('http://api.local/api/services', {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'Sunset Cruise',
        description: 'Evening boat tour',
        base_price: 200000,
        minimum_price: 150000,
        default_capacity: 12,
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { service: any }
    expect(body.service).toMatchObject({
      name: 'Sunset Cruise',
      description: 'Evening boat tour',
      base_price: 200000,
      minimum_price: 150000,
      default_capacity: 12,
      status: 'active',
      extras: [],
    })
    expect(body.service.id).toBeTruthy()

    const row = await getServiceRow(body.service.id)
    expect(row).toMatchObject({ status: 'active', base_price: 200000 })
  })

  it('Scenario 2 — minimum_price > base_price / negative / capacity 0 → 400, no row', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const bad = [
      { name: 'A', base_price: 100000, minimum_price: 150000, default_capacity: 5 }, // min > base
      { name: 'B', base_price: -1, minimum_price: 0, default_capacity: 5 }, // negative
      { name: 'C', base_price: 100000, minimum_price: 50000, default_capacity: 0 }, // capacity 0
    ]

    for (const payload of bad) {
      const res = await SELF.fetch('http://api.local/api/services', {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify(payload),
      })
      expect(res.status, payload.name).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    }

    expect(await countServices()).toBe(0)
  })

  it('Scenario 4 — an agent is forbidden from a /api/services route', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })

    const res = await SELF.fetch('http://api.local/api/services', {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({
        name: 'Nope',
        base_price: 1000,
        minimum_price: 500,
        default_capacity: 1,
      }),
    })

    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('FORBIDDEN')
    expect(await countServices()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/services (list) + GET /api/services/:id (detail)
// ---------------------------------------------------------------------------
describe('list & detail (GET /api/services[/:id])', () => {
  it('Scenario 3 — list ordered by name; ?status filters; no extras key', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    await seedService({ organizationId, name: 'Zoo Visit', status: 'active' })
    await seedService({ organizationId, name: 'Beach Day', status: 'active' })
    await seedService({ organizationId, name: 'Old Tour', status: 'inactive' })

    const all = await SELF.fetch('http://api.local/api/services', {
      headers: auth(ADMIN_EMAIL),
    })
    expect(all.status).toBe(200)
    const allBody = (await all.json()) as { services: any[] }
    expect(allBody.services.map((s) => s.name)).toEqual([
      'Beach Day',
      'Old Tour',
      'Zoo Visit',
    ])
    // List view never carries the extras key.
    for (const s of allBody.services) expect(s).not.toHaveProperty('extras')

    const active = await SELF.fetch(
      'http://api.local/api/services?status=active',
      { headers: auth(ADMIN_EMAIL) },
    )
    const activeBody = (await active.json()) as { services: any[] }
    expect(activeBody.services.map((s) => s.name)).toEqual([
      'Beach Day',
      'Zoo Visit',
    ])
  })

  it('Scenario 5 — detail includes extras ordered by name', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId } = await seedService({ organizationId })
    await seedExtra({ organizationId, serviceId, name: 'Wine' })
    await seedExtra({ organizationId, serviceId, name: 'Appetizer' })

    const res = await SELF.fetch(
      `http://api.local/api/services/${serviceId}`,
      { headers: auth(ADMIN_EMAIL) },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { service: any }
    expect(body.service.id).toBe(serviceId)
    expect(body.service.extras.map((e: any) => e.name)).toEqual([
      'Appetizer',
      'Wine',
    ])
  })

  it('Scenario 6 — unknown id on get/put/deactivate/reactivate → 404', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const missing = 'does-not-exist'

    const get = await SELF.fetch(
      `http://api.local/api/services/${missing}`,
      { headers: auth(ADMIN_EMAIL) },
    )
    const put = await SELF.fetch(`http://api.local/api/services/${missing}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'X',
        base_price: 1000,
        minimum_price: 500,
        default_capacity: 1,
      }),
    })
    const deact = await SELF.fetch(
      `http://api.local/api/services/${missing}/deactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    const react = await SELF.fetch(
      `http://api.local/api/services/${missing}/reactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )

    for (const res of [get, put, deact, react]) {
      expect(res.status).toBe(404)
      expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
    }
  })
})

// ---------------------------------------------------------------------------
// US-A13 — PUT /api/services/:id + (de)activate
// ---------------------------------------------------------------------------
describe('US-A13 — edit & (de)activate service', () => {
  it('Scenario 7 — edit updates fields, keeps status/org, advances updated_at', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId } = await seedService({
      organizationId,
      name: 'Old Name',
      basePrice: 100000,
      minimumPrice: 80000,
      defaultCapacity: 8,
      updatedAt: 1000, // stale, so the bump is observable
    })

    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'New Name',
        description: 'Updated',
        base_price: 250000,
        minimum_price: 200000,
        default_capacity: 20,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { service: any }
    expect(body.service).toMatchObject({
      id: serviceId,
      name: 'New Name',
      description: 'Updated',
      base_price: 250000,
      minimum_price: 200000,
      default_capacity: 20,
      status: 'active', // unchanged
    })

    const row = await getServiceRow(serviceId)
    expect(row).toMatchObject({
      name: 'New Name',
      base_price: 250000,
      status: 'active',
      organization_id: organizationId, // unchanged
    })
    expect(row!.updated_at).toBeGreaterThan(1000)
  })

  it('Scenario 8 — deactivate is idempotent; reactivate restores active', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId } = await seedService({ organizationId, status: 'active' })

    const d1 = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/deactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    expect(d1.status).toBe(200)
    expect(((await d1.json()) as any).service.status).toBe('inactive')

    const d2 = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/deactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    expect(d2.status).toBe(200)
    expect(((await d2.json()) as any).service.status).toBe('inactive')
    expect((await getServiceRow(serviceId))?.status).toBe('inactive')

    const re = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/reactivate`,
      { method: 'POST', headers: auth(ADMIN_EMAIL) },
    )
    expect(re.status).toBe(200)
    expect(((await re.json()) as any).service.status).toBe('active')
    expect((await getServiceRow(serviceId))?.status).toBe('active')
  })

  it('Scenario 9 — deactivating a service leaves its extras untouched', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId } = await seedService({ organizationId })
    const { extraId } = await seedExtra({
      organizationId,
      serviceId,
      status: 'active',
    })

    await SELF.fetch(`http://api.local/api/services/${serviceId}/deactivate`, {
      method: 'POST',
      headers: auth(ADMIN_EMAIL),
    })

    expect((await getExtraRow(extraId))?.status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// US-A11 — extras CRUD
// ---------------------------------------------------------------------------
describe('US-A11 — service extras', () => {
  it('Scenario 10 — add extra → 201, org matches parent, serviceId set', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId } = await seedService({ organizationId })

    const res = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/extras`,
      {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({ name: 'Photo Package', price: 7500 }),
      },
    )

    expect(res.status).toBe(201)
    const body = (await res.json()) as { extra: any }
    expect(body.extra).toMatchObject({
      name: 'Photo Package',
      price: 7500,
      status: 'active',
    })

    const row = await getExtraRow(body.extra.id)
    expect(row).toMatchObject({
      organization_id: organizationId,
      service_id: serviceId,
      status: 'active',
    })
  })

  it('Scenario 11 — add extra to unknown service → 404', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await SELF.fetch(
      'http://api.local/api/services/nope/extras',
      {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({ name: 'X', price: 100 }),
      },
    )

    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
  })

  it('Scenario 12 — edit extra → 200', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId } = await seedService({ organizationId })
    const { extraId } = await seedExtra({
      organizationId,
      serviceId,
      name: 'Old',
      price: 1000,
    })

    const res = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/extras/${extraId}`,
      {
        method: 'PUT',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({ name: 'New', price: 3000 }),
      },
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as any).extra).toMatchObject({
      id: extraId,
      name: 'New',
      price: 3000,
    })
    expect(await getExtraRow(extraId)).toMatchObject({ name: 'New', price: 3000 })
  })

  it('Scenario 13 — delete extra → 200 soft-inactive, row still present', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId } = await seedService({ organizationId })
    const { extraId } = await seedExtra({ organizationId, serviceId })

    const res = await SELF.fetch(
      `http://api.local/api/services/${serviceId}/extras/${extraId}`,
      { method: 'DELETE', headers: auth(ADMIN_EMAIL) },
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as any).extra.status).toBe('inactive')
    // Row still present — soft delete only.
    expect((await getExtraRow(extraId))?.status).toBe('inactive')
  })

  it('Scenario 14 — edit/delete extra wrong parent / unknown → 404, untouched', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId: service1 } = await seedService({
      organizationId,
      name: 'Service 1',
    })
    const { serviceId: service2 } = await seedService({
      organizationId,
      name: 'Service 2',
    })
    const { extraId } = await seedExtra({
      organizationId,
      serviceId: service1,
      name: 'Original',
      price: 1000,
    })

    // Wrong parent (extra belongs to service1, addressed under service2).
    const wrongPut = await SELF.fetch(
      `http://api.local/api/services/${service2}/extras/${extraId}`,
      {
        method: 'PUT',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({ name: 'Hacked', price: 9999 }),
      },
    )
    const wrongDel = await SELF.fetch(
      `http://api.local/api/services/${service2}/extras/${extraId}`,
      { method: 'DELETE', headers: auth(ADMIN_EMAIL) },
    )
    // Unknown extra id under the correct parent.
    const unknown = await SELF.fetch(
      `http://api.local/api/services/${service1}/extras/missing`,
      { method: 'DELETE', headers: auth(ADMIN_EMAIL) },
    )

    for (const res of [wrongPut, wrongDel, unknown]) {
      expect(res.status).toBe(404)
      expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
    }

    // Extra untouched.
    expect(await getExtraRow(extraId)).toMatchObject({
      name: 'Original',
      price: 1000,
      status: 'active',
    })
  })

  it('Scenario 15 — invalid extra price / empty name → 400', async () => {
    const { organizationId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId } = await seedService({ organizationId })

    const bad = [
      { name: 'X', price: -1 }, // negative
      { name: 'X', price: 10.5 }, // float
      { name: '', price: 100 }, // empty name
    ]

    for (const payload of bad) {
      const res = await SELF.fetch(
        `http://api.local/api/services/${serviceId}/extras`,
        {
          method: 'POST',
          headers: jsonAuth(ADMIN_EMAIL),
          body: JSON.stringify(payload),
        },
      )
      expect(res.status, JSON.stringify(payload)).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    }
  })
})

// ---------------------------------------------------------------------------
// US-A12 — per-service commission bonus
// Spec: docs/commissions/commissions.spec.md (Scenarios 1–8)
// ---------------------------------------------------------------------------
describe('US-A12 — service commission bonus', () => {
  const createService = (body: Record<string, unknown>) =>
    SELF.fetch('http://api.local/api/services', {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify(body),
    })

  it('Scenario 1 — create with commission_bonus → stored and echoed', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await createService({
      name: 'Canyon Tour',
      base_price: 150000,
      minimum_price: 100000,
      default_capacity: 12,
      commission_bonus: 5000,
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { service: any }
    expect(body.service.commission_bonus).toBe(5000)
    expect((await getServiceRow(body.service.id))?.commission_bonus).toBe(5000)
  })

  it('Scenario 2 — commission_bonus defaults to 0 when omitted', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await createService({
      name: 'No Bonus Tour',
      base_price: 150000,
      minimum_price: 100000,
      default_capacity: 12,
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { service: any }
    expect(body.service.commission_bonus).toBe(0)
  })

  it('Scenario 3 — negative / non-integer bonus → 400, no row', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    for (const commission_bonus of [-1, 10.5]) {
      const res = await createService({
        name: 'Bad Bonus',
        base_price: 150000,
        minimum_price: 100000,
        default_capacity: 12,
        commission_bonus,
      })
      expect(res.status, String(commission_bonus)).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    }
    expect(await countServices()).toBe(0)
  })

  it('Scenario 4 — PUT replaces the bonus', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { serviceId } = await seedService({ organizationId, commissionBonus: 5000 })

    const res = await SELF.fetch(`http://api.local/api/services/${serviceId}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'City Tour',
        base_price: 150000,
        minimum_price: 100000,
        default_capacity: 10,
        commission_bonus: 8000,
      }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { service: any }).service.commission_bonus).toBe(8000)
    expect((await getServiceRow(serviceId))?.commission_bonus).toBe(8000)
  })

  it('Scenario 5 — list and detail expose commission_bonus', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { serviceId } = await seedService({ organizationId, commissionBonus: 7000 })

    const list = await SELF.fetch('http://api.local/api/services', {
      headers: jsonAuth(ADMIN_EMAIL),
    })
    const listBody = (await list.json()) as { services: any[] }
    expect(listBody.services[0].commission_bonus).toBe(7000)

    const detail = await SELF.fetch(`http://api.local/api/services/${serviceId}`, {
      headers: jsonAuth(ADMIN_EMAIL),
    })
    expect(((await detail.json()) as { service: any }).service.commission_bonus).toBe(7000)
  })

  it('Scenario 7 — editing the bonus does not rewrite a sold folio\'s commission_amount', async () => {
    const { organizationId, userId: agentId } = await seedUser({
      email: ADMIN_EMAIL,
      role: 'admin',
    })
    const { serviceId } = await seedService({ organizationId, commissionBonus: 5000 })

    // A folio already sold with a snapshotted commission_amount.
    const folioId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO folios
         (id, organization_id, agent_id, status, subtotal, discount_total, total, amount_paid, commission_amount)
       VALUES (?, ?, ?, 'paid', 150000, 0, 150000, 150000, 19500)`,
    )
      .bind(folioId, organizationId, agentId)
      .run()

    await SELF.fetch(`http://api.local/api/services/${serviceId}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'City Tour',
        base_price: 150000,
        minimum_price: 100000,
        default_capacity: 10,
        commission_bonus: 99000, // bump the rate after the sale
      }),
    })

    const folio = await env.DB.prepare(
      `SELECT commission_amount FROM folios WHERE id = ?`,
    )
      .bind(folioId)
      .first<{ commission_amount: number }>()
    expect(folio?.commission_amount).toBe(19500) // snapshot unchanged
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation — Scenarios 16–18 (B4 / B3 / B1)
// ---------------------------------------------------------------------------
describe('Multitenancy isolation', () => {
  it('Scenario 16 (B4) — list is scoped to the caller’s org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedService({
      organizationId: orgA.organizationId,
      name: 'A Tour',
    })
    await seedService({
      organizationId: orgB.organizationId,
      name: 'B Tour',
    })

    const res = await SELF.fetch('http://api.local/api/services', {
      headers: auth(orgA.adminEmail),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { services: any[] }
    expect(body.services).toHaveLength(1)
    expect(body.services[0].name).toBe('A Tour')
    expect(body.services.some((s) => s.name === 'B Tour')).toBe(false)
  })

  it('Scenario 17 (B3) — cross-org service + extra ops → 404, targets untouched', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { serviceId: serviceB } = await seedService({
      organizationId: orgB.organizationId,
      name: 'B Tour',
      basePrice: 100000,
    })
    const { extraId: extraB } = await seedExtra({
      organizationId: orgB.organizationId,
      serviceId: serviceB,
      name: 'B Extra',
      price: 5000,
    })

    // Org A's admin attacks Org B's service + extra by id.
    const get = await SELF.fetch(
      `http://api.local/api/services/${serviceB}`,
      { headers: auth(orgA.adminEmail) },
    )
    const put = await SELF.fetch(`http://api.local/api/services/${serviceB}`, {
      method: 'PUT',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        name: 'Hacked',
        base_price: 1,
        minimum_price: 1,
        default_capacity: 1,
      }),
    })
    const deact = await SELF.fetch(
      `http://api.local/api/services/${serviceB}/deactivate`,
      { method: 'POST', headers: auth(orgA.adminEmail) },
    )
    const react = await SELF.fetch(
      `http://api.local/api/services/${serviceB}/reactivate`,
      { method: 'POST', headers: auth(orgA.adminEmail) },
    )
    const editExtra = await SELF.fetch(
      `http://api.local/api/services/${serviceB}/extras/${extraB}`,
      {
        method: 'PUT',
        headers: jsonAuth(orgA.adminEmail),
        body: JSON.stringify({ name: 'Hacked', price: 1 }),
      },
    )
    const delExtra = await SELF.fetch(
      `http://api.local/api/services/${serviceB}/extras/${extraB}`,
      { method: 'DELETE', headers: auth(orgA.adminEmail) },
    )

    for (const res of [get, put, deact, react, editExtra, delExtra]) {
      expect(res.status).toBe(404)
      expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
    }

    // Org B's rows are completely untouched.
    expect(await getServiceRow(serviceB)).toMatchObject({
      name: 'B Tour',
      base_price: 100000,
      status: 'active',
      organization_id: orgB.organizationId,
    })
    expect(await getExtraRow(extraB)).toMatchObject({
      name: 'B Extra',
      price: 5000,
      status: 'active',
    })
  })

  it('Scenario 18 (B1) — injected organizationId in create/edit body is ignored', async () => {
    const { orgA, orgB } = await seedTwoOrgs()

    // Create with an injected foreign org — row must land in org A.
    const create = await SELF.fetch('http://api.local/api/services', {
      method: 'POST',
      headers: jsonAuth(orgA.adminEmail),
      body: JSON.stringify({
        name: 'Injected',
        base_price: 100000,
        minimum_price: 50000,
        default_capacity: 5,
        organizationId: orgB.organizationId, // must be stripped by Zod
      }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as { service: any }
    expect((await getServiceRow(created.service.id))?.organization_id).toBe(
      orgA.organizationId,
    )

    // Edit with an injected foreign org — row stays in org A.
    const edit = await SELF.fetch(
      `http://api.local/api/services/${created.service.id}`,
      {
        method: 'PUT',
        headers: jsonAuth(orgA.adminEmail),
        body: JSON.stringify({
          name: 'Renamed',
          base_price: 120000,
          minimum_price: 60000,
          default_capacity: 6,
          organizationId: orgB.organizationId, // must be stripped by Zod
        }),
      },
    )
    expect(edit.status).toBe(200)
    const row = await getServiceRow(created.service.id)
    expect(row?.organization_id).toBe(orgA.organizationId)
    expect(row?.organization_id).not.toBe(orgB.organizationId)
  })
})
