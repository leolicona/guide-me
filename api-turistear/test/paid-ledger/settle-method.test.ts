import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-LG03 (docs/paid-ledger/spec.md) — Step 3: settling a balance captures ITS OWN payment method,
// independent of the deposit. This is the reported defect's fix — a cash-deposit / transfer-balance
// folio (and the reverse) is finally representable — plus the QR-clearance rule for mixed methods:
// the ticket is released only when the folio is `paid` AND no payment is still awaiting an admin.

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

const book = async (email: string, slotId: string, opts: { method?: string; reference?: string } = {}): Promise<string> => {
  const body: Record<string, unknown> = {
    customer_email: 'cliente@example.com',
    customer_name: 'Cliente Test',
    customer_phone: PHONE,
    down_payment: 45000,
    payment_method: opts.method ?? 'cash',
    lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }], // total 300000
  }
  if (opts.reference != null) body.payment_reference = opts.reference
  const res = await SELF.fetch(`${base}/folios`, { method: 'POST', headers: jsonAuth(email), body: JSON.stringify(body) })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}
const settle = async (email: string, folioId: string, body?: Record<string, unknown>) => {
  const res = await SELF.fetch(`${base}/folios/${folioId}/settle`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json()) as any }
}
const verify = async (email: string, folioId: string) =>
  SELF.fetch(`${base}/folios/${folioId}/verify`, { method: 'POST', headers: jsonAuth(email) }).then((r) => r.status)

const balanceRow = async (folioId: string) =>
  (await env.DB.prepare(`SELECT * FROM folio_payments WHERE folio_id = ? AND entry_type = 'payment' AND amount = 255000`)
    .bind(folioId)
    .first()) as Record<string, any> | null
const folioVerification = async (folioId: string) =>
  (await env.DB.prepare(`SELECT payment_verification FROM folios WHERE id = ?`).bind(folioId).first<{ payment_verification: string }>())!
    .payment_verification

const clearPosDb = async () => {
  for (const t of ['folio_line_extras', 'folio_lines', 'folio_access_tokens', 'folio_payments', 'folios', 'slots', 'services']) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}
beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-LG03 — settle captures its own method', () => {
  it('THE FIX: cash deposit, transfer balance → balance row is transfer+pending, QR deferred until verify', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    await seedUser({ email: ADMIN, role: 'admin', organizationId })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    const folioId = await book(AGENT, slotId, { method: 'cash' }) // cash deposit

    const s = await settle(AGENT, folioId, { method: 'transfer', payment_reference: 'BAL-TX-1' })
    expect(s.status, JSON.stringify(s.json)).toBe(200)
    expect(s.json.folio.status).toBe('paid')
    expect(s.json.folio.lines[0].qr_token ?? null).toBeNull() // deferred

    const balance = (await balanceRow(folioId))!
    expect(balance).toMatchObject({ method: 'transfer', reference: 'BAL-TX-1', verification: 'pending' })
    // deposit row is still its own cash movement — the folio now holds money collected two ways
    const deposit = (await env.DB.prepare(
      `SELECT method FROM folio_payments WHERE folio_id = ? AND entry_type='payment' AND amount = 45000`,
    ).bind(folioId).first()) as { method: string }
    expect(deposit.method).toBe('cash')
    expect(await folioVerification(folioId)).toBe('pending')

    expect(await verify(ADMIN, folioId)).toBe(200)
    expect(await folioVerification(folioId)).toBe('verified')
    expect((await balanceRow(folioId))!.verification).toBe('verified')
  })

  it('transfer balance requires a reference', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    const folioId = await book(AGENT, slotId, { method: 'cash' })
    const s = await settle(AGENT, folioId, { method: 'transfer' })
    expect(s.status).toBe(400)
  })

  it('an UNVERIFIED transfer deposit settled by CASH still defers the QR (money not confirmed)', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    await seedUser({ email: ADMIN, role: 'admin', organizationId })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    const folioId = await book(AGENT, slotId, { method: 'transfer', reference: 'DEP-TX' }) // pending deposit

    const s = await settle(AGENT, folioId, { method: 'cash' })
    expect(s.status, JSON.stringify(s.json)).toBe(200)
    expect(s.json.folio.status).toBe('paid')
    expect(s.json.folio.lines[0].qr_token ?? null).toBeNull() // deposit still unconfirmed → deferred
    expect((await balanceRow(folioId))!).toMatchObject({ method: 'cash', verification: 'not_required' })
    expect(await folioVerification(folioId)).toBe('pending') // the deposit's pending state is preserved

    expect(await verify(ADMIN, folioId)).toBe(200)
    expect(await folioVerification(folioId)).toBe('verified')
  })

  it('a VERIFIED transfer deposit settled by cash clears immediately (QR minted)', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    await seedUser({ email: ADMIN, role: 'admin', organizationId })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    const folioId = await book(AGENT, slotId, { method: 'transfer', reference: 'DEP-TX' })
    expect(await verify(ADMIN, folioId)).toBe(200) // deposit confirmed BEFORE settle

    const s = await settle(AGENT, folioId, { method: 'cash' })
    expect(s.status, JSON.stringify(s.json)).toBe(200)
    expect(s.json.folio.lines[0].qr_token).toBeTruthy() // cleared → QR minted
    expect((await balanceRow(folioId))!).toMatchObject({ method: 'cash', verification: 'not_required' })
    expect(await folioVerification(folioId)).toBe('verified')
  })

  it('a card balance clears immediately without a reference', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    const folioId = await book(AGENT, slotId, { method: 'cash' })
    const s = await settle(AGENT, folioId, { method: 'card' })
    expect(s.status, JSON.stringify(s.json)).toBe(200)
    expect(s.json.folio.lines[0].qr_token).toBeTruthy()
    expect((await balanceRow(folioId))!).toMatchObject({ method: 'card', verification: 'not_required' })
  })

  it('backward compatible: a body-less settle re-uses the deposit method (cash → cleared)', async () => {
    const { organizationId } = await seedUser({ email: AGENT, role: 'agent' })
    const slotId = await seedSlot(organizationId, await seedService(organizationId))
    const folioId = await book(AGENT, slotId, { method: 'cash' })
    const s = await settle(AGENT, folioId) // no body
    expect(s.status, JSON.stringify(s.json)).toBe(200)
    expect(s.json.folio.lines[0].qr_token).toBeTruthy()
    expect((await balanceRow(folioId))!).toMatchObject({ method: 'cash', verification: 'not_required' })
  })
})
