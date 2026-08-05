import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-LG02/LG03/LG07 (docs/paid-ledger/paid-ledger.spec.md) — Step 2: DUAL-WRITE the money engine onto the
// folio_payments ledger while the folio scalars stay authoritative. The ledger is a VERIFIED
// SHADOW; the reconciliation invariant it must uphold after EVERY money operation is:
//   Σ(payment + refund).amount   == folios.amount_paid
//   Σ(commission + reversal).amount == folios.commission_amount
// (Refund + commission_reversal rows arrive in Step 4 with the scalar-semantic change — so here the
// sums are over payment/commission rows only.) This invariant is what lets Step 4 cut the cash
// engine over to the ledger safely.

const AGENT = 'agent@empresa.com'
const ADMIN = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/pos'

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (organizationId: string): Promise<string> => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  // percent 10% (1000 bps) so commission is non-trivial and tops up at settle.
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', 1000, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, ts, ts)
    .run()
  return serviceId
}

const seedSlot = async (organizationId: string, serviceId: string): Promise<string> => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, addDays(todayStr(), 3), ts, ts)
    .run()
  return slotId
}

interface SaleOpts {
  quantity?: number
  deposit?: number
  method?: 'cash' | 'card' | 'transfer' | 'link'
  reference?: string
}
const sell = async (email: string, slotId: string, opts: SaleOpts = {}): Promise<{ status: number; json: any }> => {
  const body: Record<string, unknown> = {
    customer_email: 'cliente@example.com',
    customer_name: 'Cliente Test',
    customer_phone: PHONE,
    payment_method: opts.method ?? 'cash',
    lines: [{ slot_id: slotId, quantity: opts.quantity ?? 2, unit_price: 150000 }],
  }
  if (opts.deposit != null) body.down_payment = opts.deposit
  if (opts.reference != null) body.payment_reference = opts.reference
  const res = await SELF.fetch(`${base}/folios`, { method: 'POST', headers: jsonAuth(email), body: JSON.stringify(body) })
  return { status: res.status, json: (await res.json()) as any }
}

const settle = async (email: string, folioId: string, body?: Record<string, unknown>) => {
  const res = await SELF.fetch(`${base}/folios/${folioId}/settle`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json()) as any }
}
const verify = async (email: string, folioId: string) => {
  const res = await SELF.fetch(`${base}/folios/${folioId}/verify`, { method: 'POST', headers: jsonAuth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

const folioScalars = (id: string) =>
  env.DB.prepare(`SELECT status, amount_paid, commission_amount, payment_verification FROM folios WHERE id = ?`)
    .bind(id)
    .first<{ status: string; amount_paid: number; commission_amount: number; payment_verification: string }>()

const ledgerRows = async (folioId: string) => {
  const { results } = await env.DB.prepare(`SELECT * FROM folio_payments WHERE folio_id = ? ORDER BY entry_type, created_at`)
    .bind(folioId)
    .all()
  return results as Array<Record<string, any>>
}

// The reconciliation invariant, asserted after each operation.
const expectReconciled = async (folioId: string) => {
  const scalars = (await folioScalars(folioId))!
  const rows = await ledgerRows(folioId)
  const money = rows.filter((r) => r.entry_type === 'payment' || r.entry_type === 'refund').reduce((s, r) => s + r.amount, 0)
  const commission = rows
    .filter((r) => r.entry_type === 'commission' || r.entry_type === 'commission_reversal')
    .reduce((s, r) => s + r.amount, 0)
  expect(money, 'Σ money rows == amount_paid').toBe(scalars.amount_paid)
  expect(commission, 'Σ commission rows == commission_amount').toBe(scalars.commission_amount)
}

const clearPosDb = async () => {
  for (const t of ['folio_line_extras', 'folio_lines', 'folio_access_tokens', 'folio_payments', 'notifications',
    'folios', 'slots', 'services']) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-LG02 — confirmSale dual-writes payment + commission rows', () => {
  it('a cash paid sale writes one cleared cash payment row + one commission row', async () => {
    const { userId, organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    const { status, json } = await sell(AGENT, slotId, { quantity: 2, method: 'cash' }) // total 300000
    expect(status, JSON.stringify(json)).toBe(201)
    const folioId = json.folio.id

    const rows = await ledgerRows(folioId)
    const payments = rows.filter((r) => r.entry_type === 'payment')
    const commissions = rows.filter((r) => r.entry_type === 'commission')
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({
      amount: 300000,
      method: 'cash',
      reference: null,
      verification: 'not_required',
      collected_by: userId,
      operator_id: null,
    })
    expect(commissions).toHaveLength(1)
    expect(commissions[0]).toMatchObject({ amount: 30000, method: 'cash', verification: 'not_required' })
    await expectReconciled(folioId)
  })

  it('a transfer paid sale writes a PENDING transfer payment row; verify flips it to verified', async () => {
    const { userId, organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    await seedUser({ email: ADMIN, role: 'admin', organizationId })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    const { status, json } = await sell(AGENT, slotId, { quantity: 1, method: 'transfer', reference: 'BANK-9911' })
    expect(status, JSON.stringify(json)).toBe(201)
    const folioId = json.folio.id

    let payment = (await ledgerRows(folioId)).find((r) => r.entry_type === 'payment')!
    expect(payment).toMatchObject({ method: 'transfer', reference: 'BANK-9911', verification: 'pending', collected_by: userId })
    await expectReconciled(folioId)

    const v = await verify(ADMIN, folioId)
    expect(v.status, JSON.stringify(v.json)).toBe(200)
    payment = (await ledgerRows(folioId)).find((r) => r.entry_type === 'payment')!
    expect(payment.verification).toBe('verified')
    expect(payment.verified_by).toBeTruthy()
    await expectReconciled(folioId)
  })
})

describe('US-LG03 — settle dual-writes the balance movement + commission top-up', () => {
  it('cash settle: deposit row + balance row sum to total; commission rows sum to full', async () => {
    const { userId, organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    // booking: total 300000 (2×150000), deposit 45000. commission percent 10% → 4500 at booking.
    const created = await sell(AGENT, slotId, { quantity: 2, deposit: 45000, method: 'cash' })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    const folioId = created.json.folio.id
    await expectReconciled(folioId) // deposit-only

    const depositRows = await ledgerRows(folioId)
    expect(depositRows.filter((r) => r.entry_type === 'payment')).toHaveLength(1)
    expect(depositRows.find((r) => r.entry_type === 'payment')!.amount).toBe(45000)

    const s = await settle(AGENT, folioId)
    expect(s.status, JSON.stringify(s.json)).toBe(200)

    const rows = await ledgerRows(folioId)
    const payments = rows.filter((r) => r.entry_type === 'payment').map((r) => r.amount).sort((a, b) => a - b)
    expect(payments).toEqual([45000, 255000]) // deposit + balance == 300000
    const balance = rows.find((r) => r.entry_type === 'payment' && r.amount === 255000)!
    expect(balance).toMatchObject({ method: 'cash', verification: 'not_required', collected_by: userId })
    const commissionSum = rows.filter((r) => r.entry_type === 'commission').reduce((s, r) => s + r.amount, 0)
    expect(commissionSum).toBe(30000) // 10% of 300000, split deposit(4500) + top-up(25500)
    await expectReconciled(folioId)
  })

  it('transfer settle: balance row is PENDING and reference-carrying; verify flips it', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    await seedUser({ email: ADMIN, role: 'admin', organizationId })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    // A transfer booking (deposit by transfer) so the folio method is transfer; settle re-uses it (Step 2).
    const created = await sell(AGENT, slotId, { quantity: 2, deposit: 45000, method: 'transfer', reference: 'DEP-1' })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    const folioId = created.json.folio.id
    // clear the deposit's pending verification so the settle guard path is exercised cleanly
    await verify(ADMIN, folioId)

    const s = await settle(AGENT, folioId, { payment_reference: 'BAL-2' })
    expect(s.status, JSON.stringify(s.json)).toBe(200)
    const balance = (await ledgerRows(folioId)).find((r) => r.entry_type === 'payment' && r.amount === 255000)!
    expect(balance).toMatchObject({ method: 'transfer', reference: 'BAL-2', verification: 'pending' })
    expect((await folioScalars(folioId))!.payment_verification).toBe('pending')
    await expectReconciled(folioId)

    await verify(ADMIN, folioId)
    const after = (await ledgerRows(folioId)).filter((r) => r.entry_type === 'payment')
    expect(after.every((r) => r.verification === 'verified')).toBe(true)
    await expectReconciled(folioId)
  })
})

describe('US-LG02 — B4 cross-org isolation', () => {
  it('a sale in org A creates ledger rows only for org A', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const slotA = await seedSlot(orgA.organizationId, await seedService(orgA.organizationId))
    const { status, json } = await sell(orgA.adminEmail, slotA, { quantity: 1, method: 'cash' })
    expect(status, JSON.stringify(json)).toBe(201)
    const folioId = json.folio.id

    const rows = await ledgerRows(folioId)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.organization_id === orgA.organizationId)).toBe(true)
    // org B has no ledger rows at all
    const { results } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM folio_payments WHERE organization_id = ?`)
      .bind(orgB.organizationId)
      .all()
    expect((results[0] as { n: number }).n).toBe(0)
  })
})
