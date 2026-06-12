import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Flexible Capacity & Overbooking Tolerance (US-A36).
// Spec: docs/catalog/flexible-capacity.spec.md (Scenarios 1–16).
//
// Covers: the capacity-mode control on the admin catalog form (Hard Cap default,
// Soft Cap requires a 1–FLEX_CAP_MAX_PCT tolerance, Hard Cap coerces it to 0),
// persistence + round-trip, the raw is_flexible/flex_capacity_pct fields exposed on
// the POS reads (the client computes Effective Capacity), and the server-side
// effective-capacity guard at confirmSale. Multitenancy (B1/B3) via seedTwoOrgs.

// The hardcoded org ceiling (services/schema.ts FLEX_CAP_MAX_PCT); mirrored here so the
// boundary cases read clearly. Update both if the constant moves to an org setting.
const FLEX_CAP_MAX_PCT = 30

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
  basePrice?: number
  minimumPrice?: number
  defaultCapacity?: number
  isFlexible?: boolean
  flexCapacityPct?: number
  status?: 'active' | 'inactive'
}

const seedService = async ({
  organizationId,
  name = 'City Tour',
  basePrice = 150000,
  minimumPrice = 100000,
  defaultCapacity = 12,
  isFlexible = false,
  flexCapacityPct = 0,
  status = 'active',
}: SeedServiceOptions): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        commission_type, commission_value, is_flexible, flex_capacity_pct, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 'percent', 0, ?, ?, ?, ?, ?)`,
  )
    .bind(
      serviceId,
      organizationId,
      name,
      basePrice,
      minimumPrice,
      defaultCapacity,
      isFlexible ? 1 : 0,
      flexCapacityPct,
      status,
      ts,
      ts,
    )
    .run()
  return { serviceId }
}

interface SeedSlotOptions {
  organizationId: string
  serviceId: string
  date?: string
  startTime?: string
  capacity?: number
  booked?: number
  status?: 'active' | 'inactive'
}

const seedSlot = async ({
  organizationId,
  serviceId,
  date = '2026-06-15',
  startTime = '06:00',
  capacity = 12,
  booked = 0,
  status = 'active',
}: SeedSlotOptions): Promise<{ slotId: string }> => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, date, startTime, capacity, booked, status, ts, ts)
    .run()
  return { slotId }
}

// --- After-state readers ---------------------------------------------------

const getServiceRow = (id: string) =>
  env.DB.prepare(
    `SELECT is_flexible, flex_capacity_pct FROM services WHERE id = ?`,
  )
    .bind(id)
    .first<{ is_flexible: number; flex_capacity_pct: number }>()

const getSlotBooked = async (id: string) => {
  const r = await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`)
    .bind(id)
    .first<{ booked: number }>()
  return r?.booked ?? -1
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

// Confirm a one-line sale (customer_email is mandatory at POS; default it).
const confirmOneLine = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ customer_email: 'cliente@example.com', ...body }),
  })
  return { status: res.status, json: await res.json() }
}

beforeEach(async () => {
  await clearCatalogDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
// US-A36 — capacity mode on the admin catalog form (POST/PUT /api/services)
// ---------------------------------------------------------------------------
describe('US-A36 — define capacity type & tolerance', () => {
  const createService = (body: Record<string, unknown>) =>
    SELF.fetch(SERVICES, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'Canyon Tour',
        base_price: 150000,
        minimum_price: 100000,
        default_capacity: 12,
        // US-A37 — category is required; default it for these capacity-focused cases.
        category: 'tours',
        ...body,
      }),
    })

  it('Scenario 1 — a new service defaults to Hard Cap', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await createService({})
    expect(res.status).toBe(201)
    const body = (await res.json()) as { service: any }
    expect(body.service).toMatchObject({ is_flexible: false, flex_capacity_pct: 0 })

    const row = await getServiceRow(body.service.id)
    expect(row).toMatchObject({ is_flexible: 0, flex_capacity_pct: 0 })
  })

  it('Scenario 2 — Soft Cap requires a non-zero tolerance (omitted / 0 / negative → 400)', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const bad = [
      { is_flexible: true }, // omitted → 0
      { is_flexible: true, flex_capacity_pct: 0 },
      { is_flexible: true, flex_capacity_pct: -1 },
    ]
    for (const payload of bad) {
      const res = await createService(payload)
      expect(res.status, JSON.stringify(payload)).toBe(400)
      expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    }
    expect(await countServices()).toBe(0)
  })

  it('Scenario 3 — tolerance above the org ceiling is rejected', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await createService({
      is_flexible: true,
      flex_capacity_pct: FLEX_CAP_MAX_PCT + 1,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    expect(await countServices()).toBe(0)
  })

  it('Scenario 4 — Hard Cap coerces any tolerance to 0', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    const res = await createService({ is_flexible: false, flex_capacity_pct: 25 })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { service: any }
    expect(body.service).toMatchObject({ is_flexible: false, flex_capacity_pct: 0 })
    expect(await getServiceRow(body.service.id)).toMatchObject({
      is_flexible: 0,
      flex_capacity_pct: 0,
    })
  })

  it('Scenario 5 — accepts the ceiling exactly, and toggling back to Hard Cap clears the margin', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })

    // Create at the exact ceiling — allowed.
    const created = await createService({
      is_flexible: true,
      flex_capacity_pct: FLEX_CAP_MAX_PCT,
    })
    expect(created.status).toBe(201)
    const { service } = (await created.json()) as { service: any }
    expect(service.flex_capacity_pct).toBe(FLEX_CAP_MAX_PCT)
    void organizationId

    // PUT back to Hard Cap — pct must reset to 0.
    const put = await SELF.fetch(`${SERVICES}/${service.id}`, {
      method: 'PUT',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({
        name: 'Canyon Tour',
        base_price: 150000,
        minimum_price: 100000,
        default_capacity: 12,
        category: 'tours',
        is_flexible: false,
      }),
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as any).service).toMatchObject({
      is_flexible: false,
      flex_capacity_pct: 0,
    })
    expect(await getServiceRow(service.id)).toMatchObject({
      is_flexible: 0,
      flex_capacity_pct: 0,
    })
  })

  it('Scenario 6 — fields round-trip through the catalog detail read', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { serviceId } = await seedService({
      organizationId,
      isFlexible: true,
      flexCapacityPct: 25,
    })

    const res = await SELF.fetch(`${SERVICES}/${serviceId}`, {
      headers: auth(ADMIN_EMAIL),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).service).toMatchObject({
      is_flexible: true,
      flex_capacity_pct: 25,
    })
  })
})

// ---------------------------------------------------------------------------
// US-A36 §5 — raw fields on the POS payload (client computes Effective Capacity)
// ---------------------------------------------------------------------------
describe('US-A36 §5 — POS payload exposes raw capacity-mode fields', () => {
  it('Scenario 7 — POS service detail carries is_flexible + flex_capacity_pct (no server effective_*)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({
      organizationId,
      isFlexible: true,
      flexCapacityPct: 25,
    })
    await seedSlot({ organizationId, serviceId, capacity: 12, booked: 12 })

    const res = await SELF.fetch(`${POS}/services/${serviceId}?from=2026-06-01`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(res.status).toBe(200)
    const { service } = (await res.json()) as { service: any }
    expect(service).toMatchObject({ is_flexible: true, flex_capacity_pct: 25 })
    // Calc stays on the client: the server reports raw remaining, not an effective ceiling.
    expect(service.slots[0]).toMatchObject({ capacity: 12, booked: 12, remaining: 0 })
    expect(service.slots[0]).not.toHaveProperty('effective_capacity')
  })

  it('Scenario 8 — POS catalog rollup includes the flags; Hard Cap reads as not flexible', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const flex = await seedService({
      organizationId,
      name: 'Flexible Tour',
      isFlexible: true,
      flexCapacityPct: 20,
    })
    const hard = await seedService({ organizationId, name: 'Strict Tour' })
    await seedSlot({ organizationId, serviceId: flex.serviceId, capacity: 10, booked: 0 })
    await seedSlot({ organizationId, serviceId: hard.serviceId, capacity: 10, booked: 0 })

    const res = await SELF.fetch(`${POS}/services?today=2026-06-01`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(res.status).toBe(200)
    const { services } = (await res.json()) as { services: any[] }
    const byName = Object.fromEntries(services.map((s) => [s.name, s]))
    expect(byName['Flexible Tour']).toMatchObject({ is_flexible: true, flex_capacity_pct: 20 })
    expect(byName['Strict Tour']).toMatchObject({ is_flexible: false, flex_capacity_pct: 0 })
    // available_spots is the Σ EFFECTIVE remaining: Flexible adds floor(10×20/100)=2 → 12;
    // Strict (Hard Cap) is unchanged at its raw 10.
    expect(byName['Flexible Tour'].available_spots).toBe(12)
    expect(byName['Strict Tour'].available_spots).toBe(10)
  })

  it('Scenario 8b — a Soft Cap service booked to strict capacity still advertises its flex spots (not "Agotado")', async () => {
    // Regression: available_spots must include the flexible margin so a fully-booked-but-
    // flexible service does not read as sold out on the catalog card.
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({
      organizationId,
      name: 'Sunset Flex',
      isFlexible: true,
      flexCapacityPct: 25,
    })
    await seedSlot({ organizationId, serviceId, capacity: 12, booked: 12 }) // raw remaining 0

    const res = await SELF.fetch(`${POS}/services?today=2026-06-01`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(res.status).toBe(200)
    const { services } = (await res.json()) as { services: any[] }
    // raw remaining 0 + floor(12×25/100)=3 → 3 effective spots still sellable.
    expect(services[0].available_spots).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// US-A36 — server-side effective-capacity guard at confirmSale (US-AG11 preserved)
// ---------------------------------------------------------------------------
describe('US-A36 — POS enforces Effective Capacity', () => {
  it('Scenario 10 — a sale within the flex margin succeeds', async () => {
    // cap 12, pct 25 → +floor(3) = effective 15. booked 12 → 3 effective remaining.
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({
      organizationId,
      isFlexible: true,
      flexCapacityPct: 25,
    })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12, booked: 12 })

    const { status } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(await getSlotBooked(slotId)).toBe(14)
  })

  it('Scenario 11 — a sale beyond the effective ceiling is blocked, booked unchanged', async () => {
    // effective 15, booked 14 → only 1 left; selling 2 must fail.
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({
      organizationId,
      isFlexible: true,
      flexCapacityPct: 25,
    })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12, booked: 14 })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })
    expect(status).toBe(409)
    expect(json.error.code).toBe('SLOT_UNAVAILABLE')
    expect(await getSlotBooked(slotId)).toBe(14)
  })

  it('Scenario 12 — Hard Cap blocks at the strict ceiling', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId }) // Hard Cap
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12, booked: 12 })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(409)
    expect(json.error.code).toBe('SLOT_UNAVAILABLE')
    expect(await getSlotBooked(slotId)).toBe(12)
  })

  it('Scenario 9 — floor rounding never invents a phantom seat', async () => {
    // cap 5, pct 10 → floor(0.5) = 0 extra → effective 5. booked 5 → sold out.
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({
      organizationId,
      isFlexible: true,
      flexCapacityPct: 10,
    })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 5, booked: 5 })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(409)
    expect(json.error.code).toBe('SLOT_UNAVAILABLE')
    expect(await getSlotBooked(slotId)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation (required — Scenarios B1 / B3, seedTwoOrgs)
// ---------------------------------------------------------------------------
describe('US-A36 — multitenancy isolation', () => {
  it('Scenario 15 — B1: injected organizationId is stripped; flex fields persist as sent', async () => {
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
        is_flexible: true,
        flex_capacity_pct: 20,
        organizationId: orgB.organizationId, // injected — must be ignored
      }),
    })
    expect(res.status).toBe(201)
    const { service } = (await res.json()) as { service: any }
    expect(service).toMatchObject({ is_flexible: true, flex_capacity_pct: 20 })

    const row = await env.DB.prepare(
      `SELECT organization_id, is_flexible, flex_capacity_pct FROM services WHERE id = ?`,
    )
      .bind(service.id)
      .first<{ organization_id: string; is_flexible: number; flex_capacity_pct: number }>()
    expect(row).toMatchObject({
      organization_id: orgA.organizationId,
      is_flexible: 1,
      flex_capacity_pct: 20,
    })
  })

  it("Scenario 16 — B3: another org's Soft Cap service never leaks via the POS detail read", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    // Org B's admin is also a seller; give org A an agent to call the POS.
    await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      organizationId: orgA.organizationId,
    })
    const { serviceId } = await seedService({
      organizationId: orgB.organizationId,
      isFlexible: true,
      flexCapacityPct: 20,
    })

    const res = await SELF.fetch(`${POS}/services/${serviceId}`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
  })
})
