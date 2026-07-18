import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Agent Balance UX Overhaul — Cash vs Electronic (US-AG29).
// Spec: docs/cash-drops/agent-balance-ux-overhaul.spec.md
//
// GET /api/cash/me and each GET /api/cash/balances row gain a shift-scoped, display-only
// read model: `sales` (cash vs electronic, per-method) and `commissions` (split by bucket).
// The feature is FINANCIALLY INERT — the balance derivation is unchanged; the invariants
// `sales.cash == cash_collected` and `commissions.total == commission_total` hold by
// construction. Payment methods are extended to cash|card|transfer|link; everything ≠ cash
// is electronic (US-AG24 path: commission earned, no cash debt).

const ADMIN_EMAIL = 'admin@empresa.com'
const AGENT_EMAIL = 'agent@empresa.com'
const AGENT2_EMAIL = 'agent2@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const CASH = 'http://api.local/api/cash'
const POS = 'http://api.local/api/pos'
const nowSec = () => Math.floor(Date.now() / 1000)

type Method = 'cash' | 'card' | 'transfer' | 'link'

// --- Seeders (raw D1) ------------------------------------------------------

const seedFolio = async (opts: {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  amountPaid: number
  paymentMethod?: Method
  commissionAmount?: number
  cancellationClawback?: boolean
  cancelledAt?: number | null
  createdAt?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = opts.createdAt ?? nowSec()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, status, payment_method,
        subtotal, discount_total, total, amount_paid, commission_amount,
        cancellation_clawback, cancelled_at, created_at, updated_at)
     VALUES (?, ?, ?, 'John Diver', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.organizationId,
      opts.agentId,
      opts.status ?? 'paid',
      opts.paymentMethod ?? 'cash',
      opts.amountPaid,
      opts.amountPaid,
      opts.amountPaid,
      opts.commissionAmount ?? 0,
      opts.cancellationClawback ? 1 : 0,
      opts.cancelledAt ?? null,
      ts,
      ts,
    )
    .run()
  return id
}

// A confirmed anchor drop carrying the settlement watermark (balance_after), so the
// derivation takes the fast path exactly as production confirms do.
const seedConfirmedDrop = async (opts: {
  organizationId: string
  agentId: string
  amount: number
  balanceBefore: number
  balanceAfter: number
  reviewedAt: number
  createdAt?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = opts.createdAt ?? opts.reviewedAt
  await env.DB.prepare(
    `INSERT INTO cash_drops
       (id, organization_id, agent_id, amount, balance_before, balance_after, status, source,
        acknowledgment, created_at, updated_at, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'agent', 'not_required', ?, ?, ?)`,
  )
    .bind(
      id,
      opts.organizationId,
      opts.agentId,
      opts.amount,
      opts.balanceBefore,
      opts.balanceAfter,
      ts,
      ts,
      opts.reviewedAt,
    )
    .run()
  return id
}

const seedExpense = async (opts: {
  organizationId: string
  agentId: string
  amount: number
  createdAt?: number
}) => {
  await env.DB.prepare(
    `INSERT INTO agent_expenses (id, organization_id, agent_id, description, amount, created_at)
     VALUES (?, ?, ?, 'Gasoline', ?, ?)`,
  )
    .bind(crypto.randomUUID(), opts.organizationId, opts.agentId, opts.amount, opts.createdAt ?? nowSec())
    .run()
}

const seedService = async (
  organizationId: string,
  commissionValue = 0, // percent, basis points (service-based commission — US-A12 rev.)
): Promise<{ serviceId: string }> => {
  const serviceId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'City Tour', NULL, 150000, 100000, 12, ?, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, commissionValue, ts, ts)
    .run()
  return { serviceId }
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  startTime = '06:00',
): Promise<{ slotId: string }> => {
  const slotId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, '2026-06-15', ?, 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, startTime, ts, ts)
    .run()
  return { slotId }
}

// --- API helpers -----------------------------------------------------------

const getMyBalance = async (email: string) => {
  const res = await SELF.fetch(`${CASH}/me`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const listBalances = async (email: string) => {
  const res = await SELF.fetch(`${CASH}/balances`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}
const confirmSale = async (email: string, slotId: string, paymentMethod?: string) => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_email: 'cliente@example.com',
      ...(paymentMethod ? { payment_method: paymentMethod } : {}),
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const seedOrgWithStaff = async () => {
  const { organizationId, userId: adminId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  const { userId: agentId } = await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  return { organizationId, adminId, agentId }
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM payouts')
  await env.DB.exec('DELETE FROM cash_drops')
  await env.DB.exec('DELETE FROM agent_expenses')
  // Portal rows reference folios — clear them first (POS confirm mints a token per sale).
  await env.DB.exec('DELETE FROM cancellation_requests')
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

describe('Agent Balance UX Overhaul — cash vs electronic read model (US-AG29)', () => {
  // -------------------------------------------------------------------------
  // Sales & commission split
  // -------------------------------------------------------------------------
  it('S1 — mixed shift splits correctly and stays reconciled (financially inert)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const anchorAt = nowSec() - 1000
    await seedConfirmedDrop({
      organizationId, agentId, amount: 500000,
      balanceBefore: 513000, balanceAfter: 13000, reviewedAt: anchorAt,
    })

    // 9 cash folios totalling 845000 / commission 84500.
    for (let i = 0; i < 8; i++) {
      await seedFolio({ organizationId, agentId, amountPaid: 100000, commissionAmount: 10000 })
    }
    await seedFolio({ organizationId, agentId, amountPaid: 45000, commissionAmount: 4500 })
    // Electronic: 2 card (150000 / 15000) + 1 transfer (50000 / 5000).
    await seedFolio({ organizationId, agentId, amountPaid: 100000, paymentMethod: 'card', commissionAmount: 10000 })
    await seedFolio({ organizationId, agentId, amountPaid: 50000, paymentMethod: 'card', commissionAmount: 5000 })
    await seedFolio({ organizationId, agentId, amountPaid: 50000, paymentMethod: 'transfer', commissionAmount: 5000 })
    await seedExpense({ organizationId, agentId, amount: 32000 })

    const me = await getMyBalance(AGENT_EMAIL)
    expect(me.status).toBe(200)
    const b = me.json.balance
    expect(b.sales).toEqual({
      total: 1045000,
      cash: 845000,
      electronic: 200000,
      by_method: { card: 150000, transfer: 50000, link: 0 },
      cash_count: 9,
      electronic_count: 3,
    })
    expect(b.commissions).toEqual({ total: 104500, cash: 84500, electronic: 20000 })
    // The flat reconciling fields are untouched and agree with the buckets.
    expect(b.cash_collected).toBe(845000)
    expect(b.commission_total).toBe(104500)
    expect(b.carry_forward).toBe(13000)
    expect(b.expense_total).toBe(32000)
    expect(b.balance).toBe(13000 + 845000 - 104500 - 32000) // 721500 — same as pre-feature
  })

  it('S2 — a pure-electronic shift earns commission and drives the balance negative', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 200000, paymentMethod: 'card', commissionAmount: 20000 })

    const me = await getMyBalance(AGENT_EMAIL)
    const b = me.json.balance
    expect(b.sales.cash).toBe(0)
    expect(b.sales.cash_count).toBe(0)
    expect(b.sales.electronic).toBe(200000)
    expect(b.sales.electronic_count).toBe(1)
    expect(b.commissions).toEqual({ total: 20000, cash: 0, electronic: 20000 })
    expect(b.cash_collected).toBe(0)
    expect(b.balance).toBe(-20000) // the company owes the agent (US-AG24, now legible)
  })

  it('S3 — the sales block is scoped to the shift anchor, like the breakdown', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const anchorAt = nowSec() - 1000
    // Pre-anchor activity (any method) is settled history — never in the shift buckets.
    await seedFolio({ organizationId, agentId, amountPaid: 300000, createdAt: anchorAt - 500 })
    await seedFolio({ organizationId, agentId, amountPaid: 90000, paymentMethod: 'card', commissionAmount: 9000, createdAt: anchorAt - 500 })
    await seedConfirmedDrop({
      organizationId, agentId, amount: 300000,
      balanceBefore: 291000, balanceAfter: -9000, reviewedAt: anchorAt,
    })
    await seedFolio({ organizationId, agentId, amountPaid: 40000, commissionAmount: 4000 })

    const me = await getMyBalance(AGENT_EMAIL)
    const b = me.json.balance
    expect(b.sales).toEqual({
      total: 40000,
      cash: 40000,
      electronic: 0,
      by_method: { card: 0, transfer: 0, link: 0 },
      cash_count: 1,
      electronic_count: 0,
    })
    expect(b.commissions).toEqual({ total: 4000, cash: 4000, electronic: 0 })
  })

  it('S4 — cancellation buckets follow the totals (clawback vs absorbed)', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    // Live cash folio so the buckets are non-trivial.
    await seedFolio({ organizationId, agentId, amountPaid: 100000, commissionAmount: 10000 })
    // Card folio cancelled WITH clawback → leaves both sales.electronic and commissions.electronic.
    await seedFolio({
      organizationId, agentId, amountPaid: 80000, paymentMethod: 'card', commissionAmount: 8000,
      status: 'cancelled', cancellationClawback: true, cancelledAt: nowSec(),
    })
    // Cash folio cancelled WITHOUT clawback → leaves sales.cash but its commission stays.
    await seedFolio({
      organizationId, agentId, amountPaid: 60000, commissionAmount: 6000,
      status: 'cancelled', cancellationClawback: false, cancelledAt: nowSec(),
    })

    const me = await getMyBalance(AGENT_EMAIL)
    const b = me.json.balance
    expect(b.sales).toEqual({
      total: 100000,
      cash: 100000,
      electronic: 0,
      by_method: { card: 0, transfer: 0, link: 0 },
      cash_count: 1,
      electronic_count: 0,
    })
    // 10000 (live) + 6000 (cancelled, company absorbed) — all on cash folios.
    expect(b.commissions).toEqual({ total: 16000, cash: 16000, electronic: 0 })
    expect(b.commission_total).toBe(16000)
  })

  it('S5 — settled-cancellation reversal lands equally in cash_collected and sales.cash', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    const anchorAt = nowSec() - 1000
    // The settled shift: one cash folio fully handed in (balance_after = 0).
    const folioId = await seedFolio({
      organizationId, agentId, amountPaid: 200000, commissionAmount: 20000, createdAt: anchorAt - 500,
    })
    await seedConfirmedDrop({
      organizationId, agentId, amount: 180000,
      balanceBefore: 180000, balanceAfter: 0, reviewedAt: anchorAt,
    })
    // The settled folio is cancelled AFTER the watermark, with clawback.
    await env.DB.prepare(
      `UPDATE folios SET status = 'cancelled', cancellation_clawback = 1, cancelled_at = ? WHERE id = ?`,
    )
      .bind(nowSec(), folioId)
      .run()

    const me = await getMyBalance(AGENT_EMAIL)
    const b = me.json.balance
    // One "cash" number on screen: the reversal hits both fields identically.
    expect(b.cash_collected).toBe(-200000)
    expect(b.sales.cash).toBe(-200000)
    expect(b.commission_total).toBe(-20000)
    expect(b.commissions).toEqual({ total: -20000, cash: -20000, electronic: 0 })
    // Identical to the pre-feature derivation: 0 + (−200000) − (−20000) = −180000.
    expect(b.balance).toBe(-180000)
  })

  // -------------------------------------------------------------------------
  // US-AG25 extension — transfer & link behave like card at POS
  // -------------------------------------------------------------------------
  it('S6 — POS accepts transfer and link; commission earned, no cash debt, bucketed', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
    // Service-based commission (US-A12 rev.): the SERVICE pays 10% (1000 bp) to any seller.
    const { serviceId } = await seedService(organizationId, 1000)
    const { slotId: slotA } = await seedSlot(organizationId, serviceId, '06:00')
    const { slotId: slotB } = await seedSlot(organizationId, serviceId, '09:00')

    const transfer = await confirmSale(AGENT_EMAIL, slotA, 'transfer')
    expect(transfer.status).toBe(201)
    expect(transfer.json.folio.payment_method).toBe('transfer')

    const link = await confirmSale(AGENT_EMAIL, slotB, 'link')
    expect(link.status).toBe(201)
    expect(link.json.folio.payment_method).toBe('link')

    const me = await getMyBalance(AGENT_EMAIL)
    const b = me.json.balance
    expect(b.cash_collected).toBe(0) // electronic money never touches the cash box
    expect(b.sales.by_method).toEqual({ card: 0, transfer: 150000, link: 150000 })
    expect(b.sales.electronic).toBe(300000)
    expect(b.sales.electronic_count).toBe(2)
    // 10% base commission per sale, credited against the cash debt → negative balance.
    expect(b.commissions).toEqual({ total: 30000, cash: 0, electronic: 30000 })
    expect(b.balance).toBe(-30000)
  })

  it('S7 — an unknown payment method is rejected with 400, nothing written', async () => {
    const { organizationId } = await seedOrgWithStaff()
    const { serviceId } = await seedService(organizationId)
    const { slotId } = await seedSlot(organizationId, serviceId)

    const res = await confirmSale(AGENT_EMAIL, slotId, 'crypto')
    expect(res.status).toBe(400)
    const count = await env.DB.prepare('SELECT count(*) AS c FROM folios').first<{ c: number }>()
    expect(Number(count?.c)).toBe(0)
  })

  it('S8 — pre-feature folios (cash/card only) derive with zero-filled new methods', async () => {
    const { organizationId, agentId } = await seedOrgWithStaff()
    await seedFolio({ organizationId, agentId, amountPaid: 120000, commissionAmount: 12000 })
    await seedFolio({ organizationId, agentId, amountPaid: 50000, paymentMethod: 'card', commissionAmount: 5000 })

    const me = await getMyBalance(AGENT_EMAIL)
    const b = me.json.balance
    expect(b.sales).toEqual({
      total: 170000,
      cash: 120000,
      electronic: 50000,
      by_method: { card: 50000, transfer: 0, link: 0 },
      cash_count: 1,
      electronic_count: 1,
    })
    expect(b.commissions).toEqual({ total: 17000, cash: 12000, electronic: 5000 })
    expect(b.balance).toBe(120000 - 17000)
  })

  // -------------------------------------------------------------------------
  // US-A19 extension — admin balances carry the split (D5)
  // -------------------------------------------------------------------------
  it('S9 — admin balances rows mirror each agent’s own /me buckets', async () => {
    const { organizationId, agentId: a1 } = await seedOrgWithStaff()
    const { userId: agent2Id } = await seedUser({ email: AGENT2_EMAIL, role: 'agent', organizationId })

    // Agent 1 — mixed methods on a watermarked shift.
    const anchorAt = nowSec() - 1000
    await seedConfirmedDrop({
      organizationId, agentId: a1, amount: 100000,
      balanceBefore: 100000, balanceAfter: 0, reviewedAt: anchorAt,
    })
    await seedFolio({ organizationId, agentId: a1, amountPaid: 200000, commissionAmount: 20000 })
    await seedFolio({ organizationId, agentId: a1, amountPaid: 90000, paymentMethod: 'transfer', commissionAmount: 9000 })
    // Agent 2 — cash only, no anchor.
    await seedFolio({ organizationId, agentId: agent2Id, amountPaid: 70000, commissionAmount: 7000 })

    const me1 = await getMyBalance(AGENT_EMAIL)
    const me2 = await getMyBalance(AGENT2_EMAIL)
    const res = await listBalances(ADMIN_EMAIL)
    expect(res.status).toBe(200)

    const row1 = res.json.balances.find((r: any) => r.agent.id === a1)
    const row2 = res.json.balances.find((r: any) => r.agent.id === agent2Id)
    expect(row1.sales).toEqual(me1.json.balance.sales)
    expect(row1.commissions).toEqual(me1.json.balance.commissions)
    expect(row2.sales).toEqual(me2.json.balance.sales)
    expect(row2.commissions).toEqual(me2.json.balance.commissions)
    // Existing fields unchanged alongside the new blocks.
    expect(row1.balance).toBe(me1.json.balance.balance)
    expect(row2.cash_collected).toBe(70000)
  })

  // -------------------------------------------------------------------------
  // Roles & multitenancy
  // -------------------------------------------------------------------------
  // US-A35 — the admin reads their own /me drawer ("Tu caja"); the agent is still denied the
  // org-wide /balances surface.
  it('S10 — admin reads its own /me; agent denied /balances', async () => {
    await seedOrgWithStaff()
    expect((await getMyBalance(ADMIN_EMAIL)).status).toBe(200)
    expect((await listBalances(AGENT_EMAIL)).status).toBe(403)
  })

  it('S11 — seedTwoOrgs: buckets never leak across organizations', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const { userId: agentAId } = await seedUser({
      email: 'agent-a@empresa.com', role: 'agent', organizationId: orgA.organizationId,
    })
    const { userId: agentBId } = await seedUser({
      email: 'agent-b@empresa.com', role: 'agent', organizationId: orgB.organizationId,
    })
    await seedFolio({ organizationId: orgA.organizationId, agentId: agentAId, amountPaid: 100000, commissionAmount: 10000 })
    await seedFolio({
      organizationId: orgB.organizationId, agentId: agentBId, amountPaid: 999000,
      paymentMethod: 'card', commissionAmount: 99900,
    })

    const meA = await getMyBalance('agent-a@empresa.com')
    expect(meA.json.balance.sales.total).toBe(100000)
    expect(meA.json.balance.sales.electronic).toBe(0)

    const balA = await listBalances(orgA.adminEmail)
    expect(balA.json.balances).toHaveLength(1)
    expect(balA.json.balances[0].agent.id).toBe(agentAId)
    expect(balA.json.balances[0].sales.electronic).toBe(0)
    expect(balA.json.balances[0].sales.total).toBe(100000)
  })
})
