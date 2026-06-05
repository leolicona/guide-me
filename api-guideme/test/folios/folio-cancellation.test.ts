import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Total Folio Cancellation — US-A21.
// Spec: docs/cancellation/total-folio-cancellation.spec.md (Scenarios 1–11).
//
// Cancelling a folio releases every line's spots and records who/when/why, atomically.
// The scanner's CANCELLED gate and the cash drawer's `cancelled` exclusion are reused
// (no new code) — asserted here as integration guarantees. Multitenancy (10–11) uses the
// shared `seedTwoOrgs` helper.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'
const DATE = '2026-06-04'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

// --- Local seeders (raw D1) ------------------------------------------------

const folioCreatedAt = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000)

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, status, created_at, updated_at)
     VALUES (?, ?, 'Canyon Tour', NULL, 150000, 100000, 12, 'active', ?, ?)`,
  )
    .bind(id, organizationId, ts, ts)
    .run()
  return id
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  opts: { booked?: number; capacity?: number; date?: string } = {},
): Promise<string> => {
  const { booked = 0, capacity = 12, date = '2026-06-15' } = opts
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', ?, ?, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, date, capacity, booked, ts, ts)
    .run()
  return id
}

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  total?: number
  amountPaid?: number
  date?: string
}

const seedFolio = async ({
  organizationId,
  agentId,
  status = 'paid',
  total = 150000,
  amountPaid,
  date = DATE,
}: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = folioCreatedAt(date)
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at)
     VALUES (?, ?, ?, 'John Diver', NULL, NULL, ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(id, organizationId, agentId, status, total, total, amountPaid ?? total, ts, ts)
    .run()
  return id
}

const seedFolioLine = async (opts: {
  organizationId: string
  folioId: string
  serviceId: string
  slotId: string
  quantity: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO folio_lines
       (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date,
        slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
        qr_token, redeemed_count, created_at)
     VALUES (?, ?, ?, ?, ?, 'Canyon Tour', '2026-06-15', '06:00', ?, 150000, 100000, 150000, ?, NULL, 0, ?)`,
  )
    .bind(id, opts.organizationId, opts.folioId, opts.serviceId, opts.slotId, opts.quantity, 150000 * opts.quantity, ts)
    .run()
  return id
}

const getSlotBooked = async (slotId: string) => {
  const r = await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`)
    .bind(slotId)
    .first<{ booked: number }>()
  return r?.booked ?? null
}

const getFolioRow = (id: string) =>
  env.DB.prepare(
    `SELECT status, organization_id, cancelled_at, cancelled_by, cancellation_reason
       FROM folios WHERE id = ?`,
  )
    .bind(id)
    .first<{
      status: string
      organization_id: string
      cancelled_at: number | null
      cancelled_by: string | null
      cancellation_reason: string | null
    }>()

const clearFoliosDb = async () => {
  await env.DB.exec('DELETE FROM cash_drawer_expenses')
  await env.DB.exec('DELETE FROM cash_drawers')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearFoliosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

const FOLIOS = 'http://api.local/api/folios'
const POS = 'http://api.local/api/pos'
const TICKETS = 'http://api.local/api/tickets'

// --- API helpers -----------------------------------------------------------

const listFolios = async (email: string, query = '') => {
  const res = await SELF.fetch(`${FOLIOS}${query ? `?${query}` : ''}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const getFolio = async (email: string, id: string) => {
  const res = await SELF.fetch(`${FOLIOS}/${id}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const cancelFolio = async (email: string, id: string, body: Record<string, unknown> = {}) => {
  const res = await SELF.fetch(`${FOLIOS}/${id}/cancel`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}

// Seed an org with both an admin (the canceller) and an agent (the folio owner).
const seedOrgWithStaff = async () => {
  const { organizationId, userId: adminId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const { userId: agentId } = await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  return { organizationId, adminId, agentId }
}

// ---------------------------------------------------------------------------
// US-A21 — cancel, release spots, record it
// ---------------------------------------------------------------------------
describe('Total Folio Cancellation', () => {
  it('Scenario 1 — cancelling releases every line\'s spots', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const s1 = await seedSlot(organizationId, serviceId, { booked: 3, date: '2026-06-15' })
    const s2 = await seedSlot(organizationId, serviceId, { booked: 2, date: '2026-06-16' })
    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s1, quantity: 3 })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s2, quantity: 2 })

    const { status, json } = await cancelFolio(ADMIN_EMAIL, folioId)
    expect(status).toBe(200)
    expect(json.folio.status).toBe('cancelled')
    expect(await getSlotBooked(s1)).toBe(0)
    expect(await getSlotBooked(s2)).toBe(0)
    expect(adminId).toBeTruthy()
  })

  it('Scenario 2 — cancellation is recorded (with and without a reason)', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 1 })
    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 1 })

    const { status, json } = await cancelFolio(ADMIN_EMAIL, folioId, { reason: 'Customer no-show' })
    expect(status).toBe(200)
    expect(json.folio.cancellation_reason).toBe('Customer no-show')
    expect(json.folio.cancelled_by).toBe(adminId)
    expect(typeof json.folio.cancelled_at).toBe('number')

    const row = await getFolioRow(folioId)
    expect(row?.cancelled_by).toBe(adminId)
    expect(row?.cancellation_reason).toBe('Customer no-show')

    // No-reason path on a second, independent folio → reason null.
    const folio2 = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId: folio2, serviceId, slotId, quantity: 1 })
    const r2 = await cancelFolio(ADMIN_EMAIL, folio2)
    expect(r2.status).toBe(200)
    expect(r2.json.folio.cancellation_reason).toBeNull()
  })

  it('Scenario 3 — a booking folio can be cancelled', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 2 })
    const folioId = await seedFolio({ organizationId, agentId, status: 'booking', amountPaid: 50000 })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 2 })

    const { status, json } = await cancelFolio(ADMIN_EMAIL, folioId)
    expect(status).toBe(200)
    expect(json.folio.status).toBe('cancelled')
    expect(await getSlotBooked(slotId)).toBe(0)
  })

  it('Scenario 4 — double cancellation → 409; spots and audit unchanged', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 3 })
    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId, quantity: 3 })

    const first = await cancelFolio(ADMIN_EMAIL, folioId, { reason: 'first' })
    expect(first.status).toBe(200)
    expect(await getSlotBooked(slotId)).toBe(0)
    const after1 = await getFolioRow(folioId)

    const second = await cancelFolio(ADMIN_EMAIL, folioId, { reason: 'second' })
    expect(second.status).toBe(409)
    expect(second.json.error?.code ?? second.json.code).toBe('CONFLICT')

    // booked not released twice; original audit preserved.
    expect(await getSlotBooked(slotId)).toBe(0)
    const after2 = await getFolioRow(folioId)
    expect(after2?.cancellation_reason).toBe('first')
    expect(after2?.cancelled_at).toBe(after1?.cancelled_at)
  })

  it('Scenario 5 — multi-slot cancellation applies as one atomic unit', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const s1 = await seedSlot(organizationId, serviceId, { booked: 1, date: '2026-06-15' })
    const s2 = await seedSlot(organizationId, serviceId, { booked: 4, date: '2026-06-16' })
    const s3 = await seedSlot(organizationId, serviceId, { booked: 2, date: '2026-06-17' })
    const folioId = await seedFolio({ organizationId, agentId })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s1, quantity: 1 })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s2, quantity: 4 })
    await seedFolioLine({ organizationId, folioId, serviceId, slotId: s3, quantity: 2 })

    const { status } = await cancelFolio(ADMIN_EMAIL, folioId)
    expect(status).toBe(200)
    // All three slots released together; folio flipped.
    expect(await getSlotBooked(s1)).toBe(0)
    expect(await getSlotBooked(s2)).toBe(0)
    expect(await getSlotBooked(s3)).toBe(0)
    expect((await getFolioRow(folioId))?.status).toBe('cancelled')
  })

  it('Scenario 6 — cancelled cash drops out of a live (open) drawer', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const folioId = await seedFolio({ organizationId, agentId, total: 300000, amountPaid: 300000 })

    // Live drawer counts it.
    const before = await SELF.fetch(`http://api.local/api/cash-drawers/me?date=${DATE}`, {
      headers: auth(AGENT_EMAIL),
    })
    const beforeJson = (await before.json()) as any
    expect(beforeJson.drawer.income.total_collected).toBe(300000)
    expect(beforeJson.drawer.income.folio_count).toBe(1)

    const { status } = await cancelFolio(ADMIN_EMAIL, folioId)
    expect(status).toBe(200)

    // Live drawer excludes it.
    const after = await SELF.fetch(`http://api.local/api/cash-drawers/me?date=${DATE}`, {
      headers: auth(AGENT_EMAIL),
    })
    const afterJson = (await after.json()) as any
    expect(afterJson.drawer.income.total_collected).toBe(0)
    expect(afterJson.drawer.income.folio_count).toBe(0)
  })

  it('Scenario 7 — a cancelled folio\'s QR ticket is rejected by the scanner', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    // Mint a real ticket via POS confirm (agent).
    const confirm = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({ lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }] }),
    })
    const body = (await confirm.json()) as any
    const folioId = body.folio.id as string
    const token = body.folio.lines[0].qr_token as string
    const lineId = body.folio.lines[0].id as string

    await cancelFolio(ADMIN_EMAIL, folioId)

    const scan = await SELF.fetch(`${TICKETS}/scan`, {
      method: 'POST',
      headers: jsonAuth(AGENT_EMAIL),
      body: JSON.stringify({ token }),
    })
    const scanJson = (await scan.json()) as any
    expect(scan.status).toBe(200)
    expect(scanJson.result).toBe('invalid')
    expect(scanJson.reason).toBe('CANCELLED')

    const r = await env.DB.prepare(`SELECT redeemed_count FROM folio_lines WHERE id = ?`)
      .bind(lineId)
      .first<{ redeemed_count: number }>()
    expect(r?.redeemed_count).toBe(0)
  })

  it('Scenario 8 — admin lists and reads folios', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { booked: 2 })
    const paidId = await seedFolio({ organizationId, agentId, total: 200000, date: DATE })
    await seedFolioLine({ organizationId, folioId: paidId, serviceId, slotId, quantity: 2 })
    const cancelledId = await seedFolio({ organizationId, agentId, status: 'cancelled', date: '2026-06-03' })

    const { status, json } = await listFolios(ADMIN_EMAIL)
    expect(status).toBe(200)
    expect(json.folios).toHaveLength(2)
    // newest-first (DATE 06-04 before 06-03)
    expect(json.folios[0].id).toBe(paidId)
    expect(json.folios[0].agent.name).toBe('Test User')
    expect(json.folios[0].status).toBe('paid')

    const detail = await getFolio(ADMIN_EMAIL, paidId)
    expect(detail.status).toBe(200)
    expect(detail.json.folio.lines).toHaveLength(1)
    expect(detail.json.folio.lines[0].quantity).toBe(2)
    expect(detail.json.folio.customer_name).toBe('John Diver')

    // status filter
    const onlyCancelled = await listFolios(ADMIN_EMAIL, 'status=cancelled')
    expect(onlyCancelled.json.folios).toHaveLength(1)
    expect(onlyCancelled.json.folios[0].id).toBe(cancelledId)
  })

  it('Scenario 9 — non-admin → 403 on every folio route', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const folioId = await seedFolio({ organizationId, agentId })

    const list = await listFolios(AGENT_EMAIL)
    const detail = await getFolio(AGENT_EMAIL, folioId)
    const cancel = await cancelFolio(AGENT_EMAIL, folioId)
    expect(list.status).toBe(403)
    expect(detail.status).toBe(403)
    expect(cancel.status).toBe(403)
    // unchanged
    expect((await getFolioRow(folioId))?.status).toBe('paid')
  })

  // -------------------------------------------------------------------------
  // Multitenancy isolation (required — seedTwoOrgs)
  // -------------------------------------------------------------------------
  it('Scenario 10 — B3: a cross-org folio is unreachable (404), untouched', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceB = await seedService(orgB.organizationId)
    const slotB = await seedSlot(orgB.organizationId, serviceB, { booked: 2 })
    const folioB = await seedFolio({
      organizationId: orgB.organizationId,
      agentId: orgB.adminUserId,
    })
    await seedFolioLine({
      organizationId: orgB.organizationId,
      folioId: folioB,
      serviceId: serviceB,
      slotId: slotB,
      quantity: 2,
    })

    const detail = await getFolio(orgA.adminEmail, folioB)
    const cancel = await cancelFolio(orgA.adminEmail, folioB)
    expect(detail.status).toBe(404)
    expect(cancel.status).toBe(404)

    // org_b folio untouched.
    expect((await getFolioRow(folioB))?.status).toBe('paid')
    expect(await getSlotBooked(slotB)).toBe(2)
  })

  it('Scenario 11 — B4/B1: list org-scoped; injected org/actor ignored', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceA = await seedService(orgA.organizationId)
    const slotA = await seedSlot(orgA.organizationId, serviceA, { booked: 1 })
    const folioA = await seedFolio({
      organizationId: orgA.organizationId,
      agentId: orgA.adminUserId,
    })
    await seedFolioLine({
      organizationId: orgA.organizationId,
      folioId: folioA,
      serviceId: serviceA,
      slotId: slotA,
      quantity: 1,
    })
    await seedFolio({ organizationId: orgB.organizationId, agentId: orgB.adminUserId })

    // B4 — list returns only org_a.
    const list = await listFolios(orgA.adminEmail)
    expect(list.json.folios).toHaveLength(1)
    expect(list.json.folios[0].id).toBe(folioA)

    // B1 — injected organizationId / cancelled_by are ignored.
    const { status } = await cancelFolio(orgA.adminEmail, folioA, {
      reason: 'ok',
      organizationId: orgB.organizationId,
      cancelled_by: orgB.adminUserId,
    })
    expect(status).toBe(200)
    const row = await getFolioRow(folioA)
    expect(row?.organization_id).toBe(orgA.organizationId)
    expect(row?.cancelled_by).toBe(orgA.adminUserId)
  })
})
