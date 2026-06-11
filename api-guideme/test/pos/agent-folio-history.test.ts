import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Agent Folio History (read-only list and details) — US-AG20, US-AG21.
// Spec: docs/folio-history/agent-folio-history.spec.md (Scenarios 1–11).
//
// The list (GET /api/pos/folios) is NEW (US-AG20); the detail (GET /api/pos/folios/:id)
// already shipped with the POS receipt (US-AG08) and is reused unchanged for US-AG21.
// Both live on the agent-only POS router. Multitenancy (10–11) uses `seedTwoOrgs`.
//
// The list is always caller-scoped (organization_id + agent_id from context): there is NO
// agent_id query param, so an agent can never see another agent's folios.

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

// --- Local seeders (raw D1) ------------------------------------------------

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  total?: number
  amountPaid?: number
  customerName?: string | null
  createdAt?: number // unix seconds — control ordering / the date filter
  cancelledAt?: number | null
}

// Direct folio insert — controls agent_id / status / created_at without going through POS
// confirm (which always stamps the caller agent + now). No lines: enough for list + scope
// assertions. Detail tests that need lines/extras use confirmOneLine below.
const seedFolio = async ({
  organizationId,
  agentId,
  status = 'paid',
  total = 300000,
  amountPaid,
  customerName = null,
  createdAt,
  cancelledAt = null,
}: SeedFolioOptions): Promise<{ folioId: string }> => {
  const folioId = crypto.randomUUID()
  const ts = createdAt ?? Math.floor(Date.now() / 1000)
  const paid = amountPaid ?? total
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, payment_method, subtotal, discount_total, total, amount_paid,
        commission_amount, cancelled_at, cancelled_by, cancellation_reason,
        cancellation_clawback, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, 'cash', ?, 0, ?, ?, 0, ?, NULL, NULL, 0, ?, ?)`,
  )
    .bind(folioId, organizationId, agentId, customerName, status, total, total, paid, cancelledAt, ts, ts)
    .run()
  return { folioId }
}

// Minimal service/slot/extra seeders (mirror pos-controlled-discount.test.ts) — only used by
// the detail scenarios, which need a real folio with lines + extras + a signed QR.
const seedService = async (organizationId: string, name = 'City Tour') => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_bonus, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 150000, 100000, 12, 0, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, name, ts, ts)
    .run()
  return serviceId
}

const seedSlot = async (organizationId: string, serviceId: string, startTime = '06:00') => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, '2026-06-15', ?, 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, startTime, ts, ts)
    .run()
  return slotId
}

const seedExtra = async (organizationId: string, serviceId: string, name = 'Photo', price = 25000) => {
  const extraId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO service_extras
       (id, organization_id, service_id, name, price, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(extraId, organizationId, serviceId, name, price, ts, ts)
    .run()
  return extraId
}

const base = 'http://api.local/api/pos'

// Confirm a real one-line sale as `email` (mandatory customer_email defaulted) → parsed folio.
const confirmOneLine = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ customer_email: 'cliente@example.com', ...body }),
  })
  return { status: res.status, json: await res.json() }
}

const listFolios = async (email: string, query = '') => {
  const res = await SELF.fetch(`${base}/folios${query}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

// folio_line_extras → folio_lines → folios → slots → schedules → service_extras → services
const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM cancellation_requests')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM cancellation_requests')
  await env.DB.exec('DELETE FROM folio_access_tokens')
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

// ---------------------------------------------------------------------------
// US-AG20 — agent lists their own folios
// ---------------------------------------------------------------------------
describe('US-AG20 — agent folio history list', () => {
  it('Scenario 1 — lists only the caller’s folios, newest first; same-org other agent absent', async () => {
    const { userId: agentId, organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const other = await seedUser({ email: 'agent2@empresa.com', role: 'agent', organizationId })

    const f1 = await seedFolio({ organizationId, agentId, createdAt: 1000 })
    const f2 = await seedFolio({ organizationId, agentId, createdAt: 2000 })
    const f3 = await seedFolio({ organizationId, agentId, createdAt: 3000 })
    await seedFolio({ organizationId, agentId: other.userId, createdAt: 4000 }) // other agent

    const { status, json } = await listFolios(AGENT_EMAIL)
    expect(status).toBe(200)
    expect(json.folios.map((f: any) => f.id)).toEqual([f3.folioId, f2.folioId, f1.folioId])
  })

  it('Scenario 2 — each row carries its status; cancelled row has cancelled_at', async () => {
    const { userId: agentId, organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await seedFolio({ organizationId, agentId, status: 'paid', createdAt: 1000 })
    await seedFolio({ organizationId, agentId, status: 'booking', createdAt: 2000 })
    await seedFolio({ organizationId, agentId, status: 'cancelled', createdAt: 3000, cancelledAt: 3500 })

    const { json } = await listFolios(AGENT_EMAIL)
    const byStatus = Object.fromEntries(json.folios.map((f: any) => [f.status, f]))
    expect(Object.keys(byStatus).sort()).toEqual(['booking', 'cancelled', 'paid'])
    expect(byStatus.cancelled.cancelled_at).toBe(3500)
    expect(byStatus.paid.cancelled_at).toBeNull()
  })

  it('Scenario 3 — status filter; unrecognized value is ignored', async () => {
    const { userId: agentId, organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    await seedFolio({ organizationId, agentId, status: 'paid', createdAt: 1000 })
    await seedFolio({ organizationId, agentId, status: 'cancelled', createdAt: 2000, cancelledAt: 2500 })

    const cancelled = await listFolios(AGENT_EMAIL, '?status=cancelled')
    expect(cancelled.json.folios).toHaveLength(1)
    expect(cancelled.json.folios[0].status).toBe('cancelled')

    // Bogus value → unfiltered caller-scoped list.
    const bogus = await listFolios(AGENT_EMAIL, '?status=banana')
    expect(bogus.json.folios).toHaveLength(2)
  })

  it('Scenario 4 — date filter (created_at UTC calendar day)', async () => {
    const { userId: agentId, organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const ts0605 = Math.floor(Date.parse('2026-06-05T12:00:00Z') / 1000)
    const ts0606 = Math.floor(Date.parse('2026-06-06T12:00:00Z') / 1000)
    await seedFolio({ organizationId, agentId, createdAt: ts0605 })
    const target = await seedFolio({ organizationId, agentId, createdAt: ts0606 })

    const { json } = await listFolios(AGENT_EMAIL, '?date=2026-06-06')
    expect(json.folios.map((f: any) => f.id)).toEqual([target.folioId])
  })

  it('Scenario 5 — empty history → 200 with []', async () => {
    await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { status, json } = await listFolios(AGENT_EMAIL)
    expect(status).toBe(200)
    expect(json.folios).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// US-AG21 — agent reads one of their own folios (reuses GET /api/pos/folios/:id)
// ---------------------------------------------------------------------------
describe('US-AG21 — agent folio detail', () => {
  it('Scenario 6 — detail of the caller’s own folio returns lines, extras, totals', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const extraId = await seedExtra(organizationId, serviceId, 'Photo', 25000)

    const created = await confirmOneLine(AGENT_EMAIL, {
      customer_name: 'Jane Tourist',
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000, extras: [{ extra_id: extraId, quantity: 1 }] }],
    })
    expect(created.status).toBe(201)
    const folioId = created.json.folio.id

    const res = await SELF.fetch(`${base}/folios/${folioId}`, { headers: auth(AGENT_EMAIL) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { folio: any }
    expect(body.folio).toMatchObject({ id: folioId, status: 'paid', customer_name: 'Jane Tourist' })
    expect(body.folio.lines).toHaveLength(1)
    expect(body.folio.lines[0]).toMatchObject({ service_id: serviceId, slot_id: slotId, quantity: 2 })
    expect(body.folio.lines[0].extras[0]).toMatchObject({ name: 'Photo', price: 25000 })
    expect(body.folio.lines[0].qr).toBeTruthy() // re-show the customer's QR from history
  })

  it('Scenario 7 — another agent’s folio (same org) → 404', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const other = await seedUser({ email: 'agent2@empresa.com', role: 'agent', organizationId })
    const { folioId } = await seedFolio({ organizationId, agentId: other.userId })

    const res = await SELF.fetch(`${base}/folios/${folioId}`, { headers: auth(AGENT_EMAIL) })
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('NOT_FOUND')
  })

  it('Scenario 8 — a cancelled folio is visible read-only', async () => {
    const { userId: agentId, organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { folioId } = await seedFolio({ organizationId, agentId, status: 'cancelled', cancelledAt: 2500 })

    const res = await SELF.fetch(`${base}/folios/${folioId}`, { headers: auth(AGENT_EMAIL) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).folio.status).toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
describe('Agent folio history — authorization', () => {
  it('Scenario 9 — non-agent (admin) → 403 on the list', async () => {
    await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    const res = await SELF.fetch(`${base}/folios`, { headers: auth(ADMIN_EMAIL) })
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.code).toBe('FORBIDDEN')
  })
})

// ---------------------------------------------------------------------------
// Multitenancy isolation (B3 / B4)
// ---------------------------------------------------------------------------
describe('Agent folio history — multitenancy isolation', () => {
  it('Scenario 10 — B3: cross-org folio by id → 404', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    const agentB = await seedUser({ email: 'agent-b@empresa.com', role: 'agent', organizationId: orgB.organizationId })
    const { folioId } = await seedFolio({ organizationId: orgB.organizationId, agentId: agentB.userId })

    const res = await SELF.fetch(`${base}/folios/${folioId}`, { headers: auth(agentA) })
    expect(res.status).toBe(404)
  })

  it('Scenario 11 — B4: list is org- and caller-scoped; no param widens it', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA1Email = 'agent-a1@empresa.com'
    const a1 = await seedUser({ email: agentA1Email, role: 'agent', organizationId: orgA.organizationId })
    const a2 = await seedUser({ email: 'agent-a2@empresa.com', role: 'agent', organizationId: orgA.organizationId })
    const b = await seedUser({ email: 'agent-b@empresa.com', role: 'agent', organizationId: orgB.organizationId })

    const mine = await seedFolio({ organizationId: orgA.organizationId, agentId: a1.userId })
    await seedFolio({ organizationId: orgA.organizationId, agentId: a2.userId }) // same org, other agent
    await seedFolio({ organizationId: orgB.organizationId, agentId: b.userId }) // other org

    // Even an injected agent_id query param must not widen the caller scope.
    const { status, json } = await listFolios(agentA1Email, `?agent_id=${a2.userId}`)
    expect(status).toBe(200)
    expect(json.folios.map((f: any) => f.id)).toEqual([mine.folioId])
  })
})
