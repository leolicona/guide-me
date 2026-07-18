import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Administrator Vendor Capabilities — US-A31, A32, A33, A34, A35.
// Spec: docs/admin-vendor/admin-vendor-capabilities.spec.md (Scenarios S1–S11).
//
// The admin is a first-class seller: the SAME POS flow, scanner, and commission math agents
// use. The one asymmetry is self-authorization (US-A34): an admin's OWN cash hand-in is born
// `confirmed` (reviewed_by = self), skipping the review queue and the acknowledgment window,
// while the balance derivation is unchanged — only the approval STEP is skipped. The guard is
// `role === 'admin'` on the caller-scoped /me/drops route, so it can never leak to agents.
// Multitenancy isolation uses the shared `seedTwoOrgs` helper, per CLAUDE.md.

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const POS = 'http://api.local/api/pos'
const TICKETS = 'http://api.local/api/tickets'
const CASH = 'http://api.local/api/cash'

// --- Local seeders (raw D1) ------------------------------------------------

const seedService = async (
  organizationId: string,
  opts: { commissionType?: 'percent' | 'fixed'; commissionValue?: number } = {},
): Promise<string> => {
  const { commissionType = 'percent', commissionValue = 0 } = opts
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Canyon Tour', NULL, 250000, 100000, 12, ?, ?, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, commissionType, commissionValue, ts, ts)
    .run()
  return serviceId
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  startTime = '06:00', // (org, service, date, start_time) is UNIQUE — vary per slot
): Promise<string> => {
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

// A folio attributed to `agentId` (which may be the admin's own id), used to give a seller a
// running balance without going through the POS flow. Mirrors the cash-drops test's seeder.
const seedFolio = async (opts: {
  organizationId: string
  agentId: string
  amountPaid: number
  commissionAmount?: number
  paymentMethod?: 'cash' | 'card'
}): Promise<string> => {
  const { organizationId, agentId, amountPaid, commissionAmount = 0, paymentMethod = 'cash' } = opts
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, status, payment_method,
        subtotal, discount_total, total, amount_paid, commission_amount,
        cancellation_clawback, cancelled_at, created_at, updated_at)
     VALUES (?, ?, ?, 'John Diver', 'paid', ?, ?, 0, ?, ?, ?, 0, NULL, ?, ?)`,
  )
    .bind(id, organizationId, agentId, paymentMethod, amountPaid, amountPaid, amountPaid, commissionAmount, ts, ts)
    .run()
  return id
}

// --- API helpers -----------------------------------------------------------

const confirmSale = async (email: string, slotId: string, unitPrice = 250000, quantity = 2) => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_email: 'cliente@example.com',
      lines: [{ slot_id: slotId, quantity, unit_price: unitPrice }],
    }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const mintTicket = async (email: string, organizationId: string, quantity = 3) => {
  const serviceId = await seedService(organizationId)
  const slotId = await seedSlot(organizationId, serviceId)
  const { json } = await confirmSale(email, slotId, 150000, quantity)
  const line = json.folio.lines[0]
  return { token: line.qr_token as string, lineId: line.id as string }
}

const scan = async (email: string, token: string) => {
  const res = await SELF.fetch(`${TICKETS}/scan`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ token }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const getMyBalance = async (email: string) => {
  const res = await SELF.fetch(`${CASH}/me`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const createDrop = async (email: string, amount: number) => {
  const res = await SELF.fetch(`${CASH}/me/drops`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ amount }),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const reviewDrop = async (email: string, id: string, decision: 'confirmed' | 'rejected') => {
  const res = await SELF.fetch(`${CASH}/drops/${id}/review`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ decision }),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const registerPayout = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/payouts`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const registerCollection = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${CASH}/collections`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const listPendingDrops = async (email: string) => {
  const res = await SELF.fetch(`${CASH}/drops?status=pending`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

const errCode = (json: any): string => json.error?.code ?? json.code

const dropRow = async (id: string) =>
  env.DB.prepare(
    `SELECT status, reviewed_by, balance_after, acknowledgment, source FROM cash_drops WHERE id = ?`,
  )
    .bind(id)
    .first<{ status: string; reviewed_by: string | null; balance_after: number | null; acknowledgment: string; source: string }>()

// Seed one org with an admin (the seller under test) + an agent (the leak-guard subject).
const seedOrgWithStaff = async () => {
  const { organizationId, userId: adminId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const { userId: agentId } = await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  return { organizationId, adminId, agentId }
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM payouts')
  await env.DB.exec('DELETE FROM cash_drops')
  await env.DB.exec('DELETE FROM agent_expenses')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('Administrator Vendor Capabilities', () => {
  // -------------------------------------------------------------------------
  // US-A31 — Admin sells through the POS
  // -------------------------------------------------------------------------
  it('S1 — admin creates a folio, attributed to the admin', async () => {
    const { organizationId, adminId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)

    const { status, json } = await confirmSale(ADMIN_EMAIL, slotId)
    expect(status).toBe(201)

    const row = await env.DB.prepare(`SELECT agent_id FROM folios WHERE id = ?`)
      .bind(json.folio.id)
      .first<{ agent_id: string }>()
    expect(row?.agent_id).toBe(adminId) // agent_id = seller.userId, uniformly
  })

  // -------------------------------------------------------------------------
  // US-A33 — Admin commission via the agent formula
  // -------------------------------------------------------------------------
  it('S2 — admin commission equals the service\'s commission (seller-independent)', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId, { commissionValue: 1000 }) // 10%
    const slotId = await seedSlot(organizationId, serviceId)

    // line_total = 250000 × 2 = 500000 → 10% = 50000, with no seller-rate lookup: an agent's
    // identical cart on the same service yields the same snapshot (service-based, US-A12 rev.).
    const { status, json } = await confirmSale(ADMIN_EMAIL, slotId)
    expect(status).toBe(201)
    expect(json.folio.commission_amount).toBe(50000)

    const agentSale = await confirmSale(
      AGENT_EMAIL,
      await seedSlot(organizationId, serviceId, '09:00'),
    )
    expect(agentSale.json.folio.commission_amount).toBe(50000)
  })

  it('S3 — a zero-commission service pays any seller zero (valid rate, not an error)', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const serviceId = await seedService(organizationId) // commission_value 0
    const slotId = await seedSlot(organizationId, serviceId)

    const { json } = await confirmSale(ADMIN_EMAIL, slotId)
    expect(json.folio.commission_amount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // US-A32 — Admin validates access by scanning
  // -------------------------------------------------------------------------
  it('S4 — admin redeems a pass, identical to an agent scan', async () => {
    const { organizationId } = await seedOrgWithStaff()
    // An agent sells; the admin validates the ticket at the gate.
    const { token } = await mintTicket(AGENT_EMAIL, organizationId, 5)

    const { status, json } = await scan(ADMIN_EMAIL, token)
    expect(status).toBe(200)
    expect(json.result).toBe('valid')
    expect(json.ticket.redeemed_count).toBe(1)
  })

  // -------------------------------------------------------------------------
  // US-A34 — Self-authorized cash drop
  // -------------------------------------------------------------------------
  it('S5 — admin own drop is born confirmed, skips the queue, opens no ack window', async () => {
    const { organizationId, adminId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId: adminId, amountPaid: 500000 }) // admin holds 500000

    const { status, json } = await createDrop(ADMIN_EMAIL, 500000)
    expect(status).toBe(201)
    expect(json.drop.status).toBe('confirmed')
    expect(json.drop.reviewed_by).toBe(adminId) // reviewed_by === agent_id → "auto-confirmada"

    const row = await dropRow(json.drop.id)
    expect(row?.status).toBe('confirmed')
    expect(row?.balance_after).toBe(0) // watermark = pre-drop balance − amount
    expect(row?.acknowledgment).toBe('not_required') // no counterparty to sign

    // Absent from the admin's pending-drops review queue.
    const pending = await listPendingDrops(ADMIN_EMAIL)
    expect(pending.json.drops).toHaveLength(0)
  })

  it('S6 — accounting is byte-identical to an admin-confirmed agent drop', async () => {
    const { organizationId, adminId, agentId } = await seedOrgWithStaff()
    // Admin path: self-confirmed drop.
    await seedFolio({ organizationId, agentId: adminId, amountPaid: 500000 })
    await createDrop(ADMIN_EMAIL, 500000)
    const adminBal = await getMyBalance(ADMIN_EMAIL)

    // Agent path: identical activity, drop confirmed by the admin.
    await seedFolio({ organizationId, agentId, amountPaid: 500000 })
    const agentDrop = await createDrop(AGENT_EMAIL, 500000)
    await reviewDrop(ADMIN_EMAIL, agentDrop.json.drop.id, 'confirmed')
    const agentBal = await getMyBalance(AGENT_EMAIL)

    // Same settled outcome: balance 0, shift re-anchored on the now-confirmed drop.
    expect(adminBal.json.balance.balance).toBe(0)
    expect(agentBal.json.balance.balance).toBe(0)
    expect(adminBal.json.balance.balance).toBe(agentBal.json.balance.balance)
  })

  // -------------------------------------------------------------------------
  // US-A34 / US-A25 — Self-confirmed payout on a negative balance
  // -------------------------------------------------------------------------
  it('S7 — admin clears their own negative balance with a self-payout', async () => {
    const { organizationId, adminId } = await seedOrgWithStaff()
    // Card sale: commission credited, no cash collected → balance −20000 (company owes admin).
    await seedFolio({
      organizationId,
      agentId: adminId,
      amountPaid: 200000,
      commissionAmount: 20000,
      paymentMethod: 'card',
    })
    const before = await getMyBalance(ADMIN_EMAIL)
    expect(before.json.balance.balance).toBe(-20000)

    const { status } = await registerPayout(ADMIN_EMAIL, { agent_id: adminId, amount: 20000 })
    expect(status).toBe(201)

    const after = await getMyBalance(ADMIN_EMAIL)
    expect(after.json.balance.balance).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Guard — self-authorization must not leak to agents
  // -------------------------------------------------------------------------
  it('S8 — an agent drop is still born pending and requires admin confirmation', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 300000 })

    const { json } = await createDrop(AGENT_EMAIL, 300000)
    expect(json.drop.status).toBe('pending')
    expect(json.drop.reviewed_by).toBeNull()

    const row = await dropRow(json.drop.id)
    expect(row?.status).toBe('pending')

    // Visible in the admin's review queue.
    const pending = await listPendingDrops(ADMIN_EMAIL)
    expect(pending.json.drops.map((d: any) => d.id)).toContain(json.drop.id)
  })

  it('S9 — admin direct collection FROM an agent still owes a signature (not self-authorized)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 300000 })

    const { status, json } = await registerCollection(ADMIN_EMAIL, { agent_id: agentId, amount: 300000 })
    expect(status).toBe(201)

    // Targets someone else → keeps US-A27 semantics: confirmed (immediate) but owes a signature.
    const row = await dropRow(json.drop.id)
    expect(row?.source).toBe('admin')
    expect(row?.status).toBe('confirmed')
    expect(row?.acknowledgment).toBe('pending') // counterparty signature NOT suppressed
  })

  // -------------------------------------------------------------------------
  // Roles & Multitenancy
  // -------------------------------------------------------------------------
  it('S10 — unauthenticated requests to the widened routes are rejected', async () => {
    const sell = await SELF.fetch(`${POS}/folios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_email: 'x@y.com', lines: [] }),
    })
    expect(sell.status).toBe(401)

    const gate = await SELF.fetch(`${TICKETS}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'whatever' }),
    })
    expect(gate.status).toBe(401)
  })

  it('S11 — seedTwoOrgs: admin selling/scanning/settling never crosses org boundaries', async () => {
    const { orgA, orgB } = await seedTwoOrgs()

    // Admin A sells and self-settles in org A.
    const serviceA = await seedService(orgA.organizationId)
    const slotA = await seedSlot(orgA.organizationId, serviceA)
    const saleA = await confirmSale(orgA.adminEmail, slotA)
    expect(saleA.status).toBe(201)

    // A ticket minted in org B is unscannable by admin A (org-scoped HMAC key).
    const { token: tokenB } = await mintTicket(orgB.adminEmail, orgB.organizationId, 2)
    const crossScan = await scan(orgA.adminEmail, tokenB)
    expect(crossScan.json.result).not.toBe('valid')

    // Admin A cannot pay out org B's admin (cross-org target → 404).
    const crossPayout = await registerPayout(orgA.adminEmail, { agent_id: orgB.adminUserId, amount: 1000 })
    expect(crossPayout.status).toBe(404)
    expect(errCode(crossPayout.json)).toBe('NOT_FOUND')

    // Each admin's drawer holds ONLY its own org's sales — neither bleeds into the other.
    const balA = await getMyBalance(orgA.adminEmail)
    const balB = await getMyBalance(orgB.adminEmail)
    expect(balA.json.balance.balance).toBe(500000) // org A's 250000 × 2 only
    expect(balB.json.balance.balance).toBe(300000) // org B's 150000 × 2 mint only
  })
})
