import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Mobile Point of Sale with Controlled Discount
// (US-AG03, AG04, AG05, AG06, AG08; also AG10/AG11).
// Spec: docs/pos/pos-controlled-discount.spec.md (Scenarios 1–19).
// Multitenancy isolation (17–19) uses the shared `seedTwoOrgs` helper, per
// docs/multitenancy/multitenancy.spec.md (B4, B3, B1) and CLAUDE.md.
//
// POS is agent-facing: every endpoint requires role 'agent'. Availability reads
// take an explicit `today` / `from` so the seeded calendar is deterministic
// regardless of the real clock.

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'

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
  commissionBonus?: number
  status?: 'active' | 'inactive'
}

const seedService = async ({
  organizationId,
  name = 'City Tour',
  basePrice = 150000,
  minimumPrice = 100000,
  defaultCapacity = 12,
  commissionBonus = 0,
  status = 'active',
}: SeedServiceOptions): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_bonus, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(serviceId, organizationId, name, basePrice, minimumPrice, defaultCapacity, commissionBonus, status, ts, ts)
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
  name = 'Professional photo',
  price = 25000,
  status = 'active',
}: SeedExtraOptions): Promise<{ extraId: string }> => {
  const extraId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO service_extras
       (id, organization_id, service_id, name, price, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(extraId, organizationId, serviceId, name, price, status, ts, ts)
    .run()
  return { extraId }
}

// --- After-state readers ---------------------------------------------------

const getSlotRow = (id: string) =>
  env.DB.prepare(`SELECT booked, status FROM slots WHERE id = ?`)
    .bind(id)
    .first<{ booked: number; status: string }>()

const getFolioRow = (id: string) =>
  env.DB.prepare(
    `SELECT id, organization_id, agent_id, status, subtotal, discount_total,
            total, amount_paid, customer_name, customer_email, customer_phone
       FROM folios WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string
      organization_id: string
      agent_id: string
      status: string
      subtotal: number
      discount_total: number
      total: number
      amount_paid: number
      customer_name: string | null
      customer_email: string | null
      customer_phone: string | null
    }>()

const count = async (table: string) => {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{
    c: number
  }>()
  return r?.c ?? 0
}

// folio_line_extras → folio_lines → folios → slots → service_extras → services
const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

const base = 'http://api.local/api/pos'

// Confirm a one-line sale; returns the parsed folio for follow-up reads.
const confirmOneLine = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> => {
  // customer_email is mandatory at POS; default it so sale bodies that don't exercise
  // the email field stay valid. Explicit bodies override.
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ customer_email: 'cliente@example.com', ...body }),
  })
  return { status: res.status, json: await res.json() }
}

// ---------------------------------------------------------------------------
// US-AG03 / US-AG10 — browse catalog with live availability
// ---------------------------------------------------------------------------
describe('US-AG03 / AG10 — POS catalog & availability', () => {
  it('Scenario 1 — lists active services with availability rollup', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, name: 'Canyon Tour' })
    await seedSlot({ organizationId, serviceId, date: '2026-06-15', startTime: '06:00', capacity: 12, booked: 2 }) // remaining 10
    await seedSlot({ organizationId, serviceId, date: '2026-06-20', startTime: '06:00', capacity: 12, booked: 0 }) // remaining 12
    await seedService({ organizationId, name: 'Hidden Tour', status: 'inactive' })

    const res = await SELF.fetch(`${base}/services?today=2026-06-01`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { services: any[] }
    expect(body.services).toHaveLength(1)
    expect(body.services[0]).toMatchObject({
      id: serviceId,
      name: 'Canyon Tour',
      available_spots: 22,
      next_slot_date: '2026-06-15',
    })
  })

  it('Scenario 2 — service detail: active extras + active future slots (incl remaining 0)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    await seedExtra({ organizationId, serviceId, name: 'Photo' })
    await seedExtra({ organizationId, serviceId, name: 'Insurance', price: 8000 })
    await seedExtra({ organizationId, serviceId, name: 'Old extra', status: 'inactive' })
    await seedSlot({ organizationId, serviceId, date: '2026-06-15', startTime: '06:00', capacity: 5, booked: 5 }) // remaining 0
    await seedSlot({ organizationId, serviceId, date: '2026-06-16', startTime: '06:00', capacity: 8, booked: 0 })
    await seedSlot({ organizationId, serviceId, date: '2026-06-01', startTime: '06:00' }) // past (before `from`)
    await seedSlot({ organizationId, serviceId, date: '2026-06-17', startTime: '06:00', status: 'inactive' })

    const res = await SELF.fetch(`${base}/services/${serviceId}?from=2026-06-10`, {
      headers: auth(AGENT_EMAIL),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { service: any }
    expect(body.service.extras.map((e: any) => e.name)).toEqual(['Insurance', 'Photo'])
    expect(body.service.slots.map((s: any) => [s.date, s.remaining])).toEqual([
      ['2026-06-15', 0],
      ['2026-06-16', 8],
    ])
  })

  it('Scenario 3 — inactive / unknown / foreign service detail → 404', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const inactive = await seedService({ organizationId, status: 'inactive' })
    const ghost = crypto.randomUUID()

    for (const id of [inactive.serviceId, ghost]) {
      const res = await SELF.fetch(`${base}/services/${id}`, { headers: auth(AGENT_EMAIL) })
      expect(res.status, id).toBe(404)
      expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
    }
  })
})

// ---------------------------------------------------------------------------
// US-AG04 / AG05 / AG06 / AG08 — build cart & confirm
// ---------------------------------------------------------------------------
describe('US-AG04 / AG05 / AG06 / AG08 — confirm sale', () => {
  it('Scenario 4 — single line decrements the slot and creates a paid folio with snapshots', async () => {
    const { userId, organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, name: 'Canyon Tour', basePrice: 150000, minimumPrice: 100000 })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12, booked: 0, date: '2026-06-15', startTime: '06:00' })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })

    expect(status).toBe(201)
    expect(json.folio).toMatchObject({
      status: 'paid',
      subtotal: 300000,
      discount_total: 0,
      total: 300000,
      amount_paid: 300000,
    })
    expect(json.folio.lines[0]).toMatchObject({
      service_id: serviceId,
      slot_id: slotId,
      service_name: 'Canyon Tour',
      slot_date: '2026-06-15',
      slot_start_time: '06:00',
      quantity: 2,
      base_price: 150000,
      minimum_price: 100000,
      unit_price: 150000,
      line_total: 300000,
      extras: [],
    })

    const folioRow = await getFolioRow(json.folio.id)
    expect(folioRow).toMatchObject({
      organization_id: organizationId,
      agent_id: userId,
      status: 'paid',
      total: 300000,
      amount_paid: 300000,
    })
    expect((await getSlotRow(slotId))!.booked).toBe(2)
  })

  it('US-AG23/AG25 — commission = base % + per-service bonus; payment_method stored', async () => {
    // Agent earns 10% base; the service adds a 5000-per-pass bonus. Card payment.
    const { organizationId } = await seedUser({
      email: AGENT_EMAIL,
      role: 'agent',
      baseCommission: 10,
    })
    const { serviceId } = await seedService({
      organizationId,
      basePrice: 150000,
      minimumPrice: 100000,
      commissionBonus: 5000,
    })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12, booked: 0 })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      payment_method: 'card',
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })

    expect(status).toBe(201)
    // total = 300000 → base 10% = 30000; bonus = 2 × 5000 = 10000 → commission 40000.
    expect(json.folio.payment_method).toBe('card')
    expect(json.folio.commission_amount).toBe(40000)

    const row = await env.DB.prepare(
      `SELECT payment_method, commission_amount FROM folios WHERE id = ?`,
    )
      .bind(json.folio.id)
      .first<{ payment_method: string; commission_amount: number }>()
    expect(row?.payment_method).toBe('card')
    expect(row?.commission_amount).toBe(40000)
  })

  it('US-AG25 — payment_method defaults to cash; zero base commission → 0', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12, booked: 0 })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(json.folio.payment_method).toBe('cash')
    expect(json.folio.commission_amount).toBe(0)
  })

  it('Scenario 5 — extras snapshotted & summed; extra price comes from DB', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, basePrice: 150000, minimumPrice: 100000 })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12 })
    const { extraId } = await seedExtra({ organizationId, serviceId, name: 'Photo', price: 25000 })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [
        {
          slot_id: slotId,
          quantity: 1,
          unit_price: 150000,
          // Attempt to forge an extra price — schema strips it; DB price wins.
          extras: [{ extra_id: extraId, quantity: 2, price: 1 }],
        },
      ],
    })

    expect(status).toBe(201)
    const line = json.folio.lines[0]
    expect(line.extras[0]).toMatchObject({ extra_id: extraId, name: 'Photo', price: 25000, quantity: 2 })
    expect(line.line_total).toBe(150000 + 25000 * 2)
    expect(json.folio.total).toBe(200000)
    expect(await count('folio_line_extras')).toBe(1)
  })

  it('Scenario 6 — in-range discount accepted; totals & discount_total server-computed', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, basePrice: 150000, minimumPrice: 120000 })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12 })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 130000 }],
      total: 1, // forged — must be ignored
    })

    expect(status).toBe(201)
    expect(json.folio.lines[0].unit_price).toBe(130000)
    expect(json.folio.subtotal).toBe(260000)
    expect(json.folio.discount_total).toBe(40000) // (150000-130000)*2
    expect(json.folio.total).toBe(260000)
  })

  it('Scenario 7 — discount below minimum → 400 PRICE_BELOW_MINIMUM, nothing written, no decrement', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, basePrice: 150000, minimumPrice: 120000 })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12, booked: 0 })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 119000 }],
    })

    expect(status).toBe(400)
    expect(json.error.code).toBe('PRICE_BELOW_MINIMUM')
    expect(await count('folios')).toBe(0)
    expect((await getSlotRow(slotId))!.booked).toBe(0)
  })

  it('Scenario 8 — price above base (negative discount) → 400 VALIDATION_ERROR', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId, basePrice: 150000, minimumPrice: 120000 })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12 })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 160000 }],
    })

    expect(status).toBe(400)
    expect(json.error.code).toBe('VALIDATION_ERROR')
    expect(await count('folios')).toBe(0)
  })

  it('Scenario 9 — multi-line cart decrements every slot', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const a = await seedService({ organizationId, name: 'A' })
    const b = await seedService({ organizationId, name: 'B' })
    const slotA = await seedSlot({ organizationId, serviceId: a.serviceId, capacity: 12, booked: 0, startTime: '06:00' })
    const slotB = await seedSlot({ organizationId, serviceId: b.serviceId, capacity: 12, booked: 0, startTime: '07:00' })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [
        { slot_id: slotA.slotId, quantity: 2, unit_price: 150000 },
        { slot_id: slotB.slotId, quantity: 3, unit_price: 150000 },
      ],
    })

    expect(status).toBe(201)
    expect(json.folio.lines).toHaveLength(2)
    expect((await getSlotRow(slotA.slotId))!.booked).toBe(2)
    expect((await getSlotRow(slotB.slotId))!.booked).toBe(3)
  })

  it('Scenario 10 — US-AG11 race: a slot cannot satisfy quantity → 409, full compensation, no folio', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const a = await seedService({ organizationId, name: 'A' })
    const b = await seedService({ organizationId, name: 'B' })
    // slot_2 (roomy) is listed FIRST so it decrements before slot_1 fails.
    const slot2 = await seedSlot({ organizationId, serviceId: b.serviceId, capacity: 12, booked: 0, startTime: '07:00' })
    const slot1 = await seedSlot({ organizationId, serviceId: a.serviceId, capacity: 12, booked: 11, startTime: '06:00' }) // 1 left

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [
        { slot_id: slot2.slotId, quantity: 1, unit_price: 150000 },
        { slot_id: slot1.slotId, quantity: 2, unit_price: 150000 },
      ],
    })

    expect(status).toBe(409)
    expect(json.error.code).toBe('SLOT_UNAVAILABLE')
    expect(await count('folios')).toBe(0)
    expect((await getSlotRow(slot2.slotId))!.booked).toBe(0) // compensated back
    expect((await getSlotRow(slot1.slotId))!.booked).toBe(11) // untouched
  })

  it('Scenario 11 — inactive / foreign / unknown slot or inactive parent service → 404, no decrement', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const active = await seedService({ organizationId, name: 'Active' })
    const inactiveSvc = await seedService({ organizationId, name: 'Inactive', status: 'inactive' })
    const inactiveSlot = await seedSlot({ organizationId, serviceId: active.serviceId, status: 'inactive', startTime: '06:00' })
    const slotOfInactiveSvc = await seedSlot({ organizationId, serviceId: inactiveSvc.serviceId, startTime: '07:00' })

    const cases = [crypto.randomUUID(), inactiveSlot.slotId, slotOfInactiveSvc.slotId]
    for (const slotId of cases) {
      const { status, json } = await confirmOneLine(AGENT_EMAIL, {
        lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
      })
      expect(status, slotId).toBe(404)
      expect(json.error.code).toBe('NOT_FOUND')
    }
    expect(await count('folios')).toBe(0)
    expect((await getSlotRow(inactiveSlot.slotId))!.booked).toBe(0)
    expect((await getSlotRow(slotOfInactiveSvc.slotId))!.booked).toBe(0)
  })

  it('Scenario 12 — extra not belonging to the line’s service → 404', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const a = await seedService({ organizationId, name: 'A' })
    const b = await seedService({ organizationId, name: 'B' })
    const slotA = await seedSlot({ organizationId, serviceId: a.serviceId, capacity: 12 })
    const extraB = await seedExtra({ organizationId, serviceId: b.serviceId, name: 'B-extra' })

    const { status, json } = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotA.slotId, quantity: 1, unit_price: 150000, extras: [{ extra_id: extraB.extraId, quantity: 1 }] }],
    })

    expect(status).toBe(404)
    expect(json.error.code).toBe('NOT_FOUND')
    expect(await count('folios')).toBe(0)
  })

  it('Scenario 13 — empty cart / duplicate slot_id / bad quantity → 400', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12 })

    const bad = [
      { lines: [] },
      {
        lines: [
          { slot_id: slotId, quantity: 1, unit_price: 150000 },
          { slot_id: slotId, quantity: 1, unit_price: 150000 },
        ],
      },
      { lines: [{ slot_id: slotId, quantity: 0, unit_price: 150000 }] },
    ]
    for (const body of bad) {
      const { status, json } = await confirmOneLine(AGENT_EMAIL, body)
      expect(status, JSON.stringify(body)).toBe(400)
      expect(json.error.code).toBe('VALIDATION_ERROR')
    }
    expect(await count('folios')).toBe(0)
  })

  it('Scenario 14 — folio read-back returns lines + extras', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { serviceId } = await seedService({ organizationId })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12 })
    const { extraId } = await seedExtra({ organizationId, serviceId, name: 'Photo', price: 25000 })

    const created = await confirmOneLine(AGENT_EMAIL, {
      customer_name: 'Jane Tourist',
      customer_email: 'jane@example.com',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000, extras: [{ extra_id: extraId, quantity: 1 }] }],
    })
    const folioId = created.json.folio.id

    const res = await SELF.fetch(`${base}/folios/${folioId}`, { headers: auth(AGENT_EMAIL) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { folio: any }
    expect(body.folio).toMatchObject({ id: folioId, status: 'paid', customer_name: 'Jane Tourist', customer_email: 'jane@example.com' })
    expect(body.folio.lines).toHaveLength(1)
    expect(body.folio.lines[0].extras[0]).toMatchObject({ name: 'Photo', price: 25000 })
  })

  it('Scenario 15 — other agent / foreign / unknown folio → 404', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const other = 'agent2@empresa.com'
    await seedUser({ email: other, role: 'agent', organizationId })
    const { serviceId } = await seedService({ organizationId })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12 })

    const created = await confirmOneLine(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    const folioId = created.json.folio.id

    // Another agent in the same org cannot read it.
    const r1 = await SELF.fetch(`${base}/folios/${folioId}`, { headers: auth(other) })
    expect(r1.status).toBe(404)
    // Unknown id.
    const r2 = await SELF.fetch(`${base}/folios/${crypto.randomUUID()}`, { headers: auth(AGENT_EMAIL) })
    expect(r2.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// US-AG* — authorization
// ---------------------------------------------------------------------------
describe('POS — authorization', () => {
  it('Scenario 16 — admin role → 403 on any /api/pos route', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const { serviceId } = await seedService({ organizationId })
    const { slotId } = await seedSlot({ organizationId, serviceId, capacity: 12 })

    const calls = [
      SELF.fetch(`${base}/services`, { headers: auth(ADMIN_EMAIL) }),
      SELF.fetch(`${base}/services/${serviceId}`, { headers: auth(ADMIN_EMAIL) }),
      SELF.fetch(`${base}/folios`, {
        method: 'POST',
        headers: jsonAuth(ADMIN_EMAIL),
        body: JSON.stringify({ lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }] }),
      }),
    ]
    for (const p of calls) {
      const res = await p
      expect(res.status).toBe(403)
      expect(((await res.json()) as any).error.code).toBe('FORBIDDEN')
    }
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation (B4 / B3 / B1)
// ---------------------------------------------------------------------------
describe('POS — multitenancy isolation', () => {
  // seedTwoOrgs creates admins; seed an agent in each org for POS calls.
  const seedAgents = async (orgAId: string, orgBId: string) => {
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    const a = await seedUser({ email: agentA, role: 'agent', organizationId: orgAId })
    const b = await seedUser({ email: agentB, role: 'agent', organizationId: orgBId })
    return { agentA, agentB, agentAId: a.userId, agentBId: b.userId }
  }

  it('Scenario 17 — B4: POS catalog/detail scoped to caller org', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { agentA } = await seedAgents(orgA.organizationId, orgB.organizationId)
    const a = await seedService({ organizationId: orgA.organizationId, name: 'A tour' })
    const b = await seedService({ organizationId: orgB.organizationId, name: 'B tour' })
    await seedSlot({ organizationId: orgA.organizationId, serviceId: a.serviceId, date: '2026-06-15' })
    await seedSlot({ organizationId: orgB.organizationId, serviceId: b.serviceId, date: '2026-06-15' })

    const listRes = await SELF.fetch(`${base}/services?today=2026-06-01`, { headers: auth(agentA) })
    const listBody = (await listRes.json()) as { services: any[] }
    expect(listBody.services).toHaveLength(1)
    expect(listBody.services[0].id).toBe(a.serviceId)

    // org A agent cannot read org B's service detail
    const detailRes = await SELF.fetch(`${base}/services/${b.serviceId}`, { headers: auth(agentA) })
    expect(detailRes.status).toBe(404)
  })

  it('Scenario 18 — B3: cross-org confirm & folio read → 404, slot untouched', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { agentA, agentB } = await seedAgents(orgA.organizationId, orgB.organizationId)
    const b = await seedService({ organizationId: orgB.organizationId })
    const slotB = await seedSlot({ organizationId: orgB.organizationId, serviceId: b.serviceId, capacity: 12, booked: 0 })

    // agent A confirms a cart citing org B's slot → 404, slot untouched.
    const confirm = await confirmOneLine(agentA, {
      lines: [{ slot_id: slotB.slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(confirm.status).toBe(404)
    expect(confirm.json.error.code).toBe('NOT_FOUND')
    expect((await getSlotRow(slotB.slotId))!.booked).toBe(0)
    expect(await count('folios')).toBe(0)

    // agent B creates a real folio; agent A cannot read it.
    const slotBOk = await seedSlot({ organizationId: orgB.organizationId, serviceId: b.serviceId, capacity: 12, startTime: '09:00' })
    const made = await confirmOneLine(agentB, {
      lines: [{ slot_id: slotBOk.slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(made.status).toBe(201)
    const foreign = await SELF.fetch(`${base}/folios/${made.json.folio.id}`, { headers: auth(agentA) })
    expect(foreign.status).toBe(404)
  })

  it('Scenario 19 — B1: injected organizationId / agent_id / status / total ignored', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { agentA, agentAId } = await seedAgents(orgA.organizationId, orgB.organizationId)
    const a = await seedService({ organizationId: orgA.organizationId, basePrice: 150000, minimumPrice: 100000 })
    const { slotId } = await seedSlot({ organizationId: orgA.organizationId, serviceId: a.serviceId, capacity: 12 })

    const { status, json } = await confirmOneLine(agentA, {
      organizationId: orgB.organizationId,
      agent_id: 'someone-else',
      status: 'booking',
      total: 1,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })

    expect(status).toBe(201)
    const folioRow = await getFolioRow(json.folio.id)
    expect(folioRow).toMatchObject({
      organization_id: orgA.organizationId,
      agent_id: agentAId,
      status: 'paid',
      total: 150000,
    })
  })
})
