import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-LG04 (docs/paid-ledger/paid-ledger.spec.md) — Step 4: the cash engine reads the ledger. The flagship proof
// is that a MIXED-method folio (cash deposit + transfer balance) finally buckets correctly — the
// exact reconciliation defect that started this epic — and that a cancellation nets a folio back out
// of the buckets via its ledger reversal rows (the §12a replacement), end-to-end through the API.

const AGENT = 'agent@empresa.com'
const ADMIN = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const pos = 'http://api.local/api/pos'

const todayStr = () => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (organizationId: string) => {
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', 1000, 'active', ?, ?)`,
  ).bind(serviceId, organizationId, ts, ts).run()
  return serviceId
}
// `daysOut` decides which tier of the inherited cancellation ladder a cancellation lands in, which
// is what makes a reversal total or partial. These tests are about the LEDGER's arithmetic, not the
// ladder's, so the cancellation case pins the departure beyond 120h to keep the reversal total —
// otherwise the buckets net to a retention and the scenario stops testing what it is named for.
const seedSlot = async (organizationId: string, serviceId: string, daysOut = 3) => {
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  ).bind(slotId, organizationId, serviceId, addDays(todayStr(), daysOut), ts, ts).run()
  return slotId
}
const post = (email: string, path: string, body?: unknown) =>
  SELF.fetch(`${pos}${path}`, { method: 'POST', headers: jsonAuth(email), body: body ? JSON.stringify(body) : undefined })

const myBalance = async (email: string) => {
  const res = await SELF.fetch('http://api.local/api/cash/me', { headers: auth(email) })
  return (await res.json()) as any
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

describe('US-LG04 — the cash engine buckets by the ledger', () => {
  it('THE FIX: a cash-deposit / transfer-balance folio splits across cash and transfer correctly', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    await seedUser({ email: ADMIN, role: 'admin', organizationId })
    const slot = await seedSlot(organizationId, await seedService(organizationId))

    // Booking: total 300000, cash deposit 45000. commission percent 10% → 4500 on the deposit (cash).
    const booked = await post(AGENT, '/folios', {
      customer_name: 'Cliente', customer_phone: PHONE, down_payment: 45000, payment_method: 'cash',
      lines: [{ slot_id: slot, quantity: 2, unit_price: 150000 }],
    })
    const folioId = ((await booked.json()) as any).folio.id

    // Settle the 255000 balance by TRANSFER; admin verifies. Commission tops up 25500 (transfer).
    expect((await post(AGENT, `/folios/${folioId}/settle`, { method: 'transfer', payment_reference: 'BAL-9' })).status).toBe(200)
    expect((await post(ADMIN, `/folios/${folioId}/verify`)).status).toBe(200)

    const b = (await myBalance(AGENT)).balance
    // The one folio's money is split by how it was actually collected — the reconciliation fix.
    expect(b.sales.cash).toBe(45000)
    expect(b.cash_collected).toBe(45000)
    expect(b.sales.by_method).toEqual({ card: 0, transfer: 255000, link: 0 })
    expect(b.sales.electronic).toBe(255000)
    expect(b.sales.total).toBe(300000)
    // Commission buckets follow the collection method of each accrual.
    expect(b.commissions).toEqual({ total: 30000, cash: 4500, electronic: 25500 })
    // Only the cash portion is the agent's cash debt.
    expect(b.balance).toBe(45000 - 30000) // 15000
  })

  it('cancelling the mixed folio nets both buckets back to zero (ledger reversal, no §12a)', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    await seedUser({ email: ADMIN, role: 'admin', organizationId })
    const slot = await seedSlot(organizationId, await seedService(organizationId), 7)

    const booked = await post(AGENT, '/folios', {
      customer_name: 'Cliente', customer_phone: PHONE, down_payment: 45000, payment_method: 'cash',
      lines: [{ slot_id: slot, quantity: 2, unit_price: 150000 }],
    })
    const folioId = ((await booked.json()) as any).folio.id
    await post(AGENT, `/folios/${folioId}/settle`, { method: 'transfer', payment_reference: 'BAL-9' })
    await post(ADMIN, `/folios/${folioId}/verify`)

    // Admin cancels the whole folio → reversal rows net every bucket + the commission.
    // (The `clawback: true` this used to send is withdrawn — Cancellation Policy Engine D10. The
    // departure is 7 days out, which is the inherited ladder's full-refund tier, so the reversal is
    // still total and this scenario's premise is unchanged: what the ledger writes here did not
    // move. A partial reversal is covered by the engine's own tests.)
    expect((await SELF.fetch(`http://api.local/api/folios/${folioId}/cancel`, {
      method: 'POST', headers: jsonAuth(ADMIN), body: JSON.stringify({}),
    })).status).toBe(200)

    const b = (await myBalance(AGENT)).balance
    expect(b.sales.cash).toBe(0)
    expect(b.sales.by_method).toEqual({ card: 0, transfer: 0, link: 0 })
    expect(b.cash_collected).toBe(0)
    expect(b.commissions).toEqual({ total: 0, cash: 0, electronic: 0 })
    expect(b.balance).toBe(0)
  })
})
