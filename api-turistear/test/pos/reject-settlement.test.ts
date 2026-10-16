import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearFullDb } from '../helpers/tenancy'
import { sessionCookie } from '../helpers/session'
import { sweepExpiredBookings } from '../../src/routes/pos/sweep'

// bug: reject-settle-voids-deposit — rejecting the PENDING transfer of a sale that also holds
// cleared money (a cash deposit under a transfer settlement) used to cancel the whole sale and
// reverse every peso, the cash deposit included. A reject now withdraws the pending payment only;
// the sale is cancelled only when that payment was all it had.
//
// Figures: one 1,500.00 seat at 10% commission (1000 bp). A 450.00 cash deposit accrues 45.00 of
// commission; settling the 1,050.00 balance tops it up to 150.00.

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'
const DEPOSIT = 45000
const PRICE = 150000
const auth = (email: string) => ({ Cookie: sessionCookie(email) })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/pos'

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, ?, 100000, 12, 'percent', 1000, 'active', ?, ?)`,
  )
    .bind(id, organizationId, PRICE, ts, ts)
    .run()
  return id
}

// Three days out: always sellable, and the apartado's hold (24 h before) is still ahead.
const seedSlot = async (organizationId: string, serviceId: string, daysOut = 3): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, addDays(todayStr(), daysOut), ts, ts)
    .run()
  return id
}

const seedAgentAndAdmin = async () => {
  const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  const serviceId = await seedService(organizationId)
  const slotId = await seedSlot(organizationId, serviceId)
  return { organizationId, serviceId, slotId }
}

const sell = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      customer_email: 'cliente@example.com',
      ...body,
    }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const post = async (email: string, path: string, body?: Record<string, unknown>) => {
  const res = await SELF.fetch(`${base}${path}`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any }
}

const getFolio = async (email: string, id: string) => {
  const res = await SELF.fetch(`${base}/folios/${id}`, { headers: auth(email) })
  return ((await res.json()) as any).folio
}

const cashCollected = async (email: string): Promise<number> => {
  const res = await SELF.fetch('http://api.local/api/cash/me', { headers: auth(email) })
  return ((await res.json()) as any).balance.cash_collected
}

const bookedOf = async (slotId: string): Promise<number> =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(slotId).first<{ booked: number }>())!
    .booked

const ledgerSum = async (folioId: string, entryTypes: string[]): Promise<number> =>
  Number(
    (
      await env.DB.prepare(
        `SELECT coalesce(sum(amount), 0) AS s FROM folio_payments
         WHERE folio_id = ? AND entry_type IN (${entryTypes.map(() => '?').join(',')})`,
      )
        .bind(folioId, ...entryTypes)
        .first<{ s: number }>()
    )?.s ?? 0,
  )

const allocatedSum = async (folioId: string): Promise<number> =>
  Number(
    (
      await env.DB.prepare(
        `SELECT coalesce(sum(a.amount), 0) AS s FROM folio_payment_allocations a
         JOIN folio_lines l ON l.id = a.folio_line_id WHERE l.folio_id = ?`,
      )
        .bind(folioId)
        .first<{ s: number }>()
    )?.s ?? 0,
  )

const notificationEvents = async (folioId: string): Promise<string[]> =>
  (
    await env.DB.prepare(
      `SELECT DISTINCT event FROM notifications WHERE folio_id = ? ORDER BY event`,
    )
      .bind(folioId)
      .all<{ event: string }>()
  ).results.map((r) => r.event)

// A cash-deposit apartado whose balance was then settled by transfer: paid, awaiting an admin.
const cashDepositTransferSettle = async (slotId: string) => {
  const { json: sold } = await sell(AGENT_EMAIL, {
    payment_method: 'cash',
    down_payment: DEPOSIT,
    lines: [{ slot_id: slotId, quantity: 1, unit_price: PRICE }],
  })
  const settled = await post(AGENT_EMAIL, `/folios/${sold.folio.id}/settle`, {
    method: 'transfer',
    payment_reference: 'BBVA-SALDO-1050',
  })
  expect(settled.status).toBe(200)
  expect(settled.json.folio.status).toBe('paid')
  expect(settled.json.folio.payment_verification).toBe('pending')
  return sold.folio.id as string
}

beforeEach(async () => {
  await clearFullDb()
})
afterEach(() => vi.restoreAllMocks())

describe('bug: reject-settle-voids-deposit — a rejected settlement keeps the sale', () => {
  it('cash deposit + transfer settle + reject → an apartado again, deposit and seats intact', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const folioId = await cashDepositTransferSettle(slotId)
    const before = await getFolio(AGENT_EMAIL, folioId)
    expect(before.booking_expires_at).toBeTruthy()

    const { status, json } = await post(ADMIN_EMAIL, `/folios/${folioId}/reject`, {
      reason: 'No llegó la transferencia del saldo',
    })
    expect(status).toBe(200)

    // The sale survives as an apartado owing its balance — never cancelled.
    expect(json.folio.status).toBe('booking')
    expect(json.folio.amount_paid).toBe(DEPOSIT)
    expect(json.folio.payment_verification).toBe('not_required')
    expect(json.folio.lines[0].qr_token).toBeNull()
    expect(json.folio.booking_expires_at).toBe(before.booking_expires_at)
    expect(await bookedOf(slotId)).toBe(1)

    // The seller's corte still asks for the 450.00 in their drawer; the commission returns to
    // what the deposit earned (10% of 450.00).
    expect(await cashCollected(AGENT_EMAIL)).toBe(DEPOSIT)
    expect(json.folio.commission_amount).toBe(4500)
    expect(await ledgerSum(folioId, ['commission', 'commission_reversal'])).toBe(4500)

    // The ledger reconciles: Σ money rows == amount_paid, Σ allocations == what the lines hold.
    expect(await ledgerSum(folioId, ['payment', 'refund'])).toBe(DEPOSIT)
    expect(await allocatedSum(folioId)).toBe(DEPOSIT)

    // The rejected transfer stops reading as pending, and its reversal is on the record.
    const payments = json.folio.payments as Array<{ kind: string; method: string; verification: string; amount: number }>
    expect(payments.find((p) => p.kind === 'payment' && p.method === 'transfer')?.verification).toBe(
      'rejected',
    )
    expect(payments.find((p) => p.kind === 'refund')?.amount).toBe(-(PRICE - DEPOSIT))

    // The customer is told the sale continues, not that it was cancelled.
    expect(await notificationEvents(folioId)).toContain('payment_rejected_booking')
    expect(await notificationEvents(folioId)).not.toContain('payment_rejected')

    // …and it leaves the admin's Por verificar queue.
    const res = await SELF.fetch('http://api.local/api/folios?verification=pending', {
      headers: auth(ADMIN_EMAIL),
    })
    const queue = ((await res.json()) as any).folios
    expect(queue.find((f: any) => f.id === folioId)).toBeUndefined()
  })

  it('after the reject the apartado settles again in cash → paid with its ticket', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const folioId = await cashDepositTransferSettle(slotId)
    await post(ADMIN_EMAIL, `/folios/${folioId}/reject`)

    const { status, json } = await post(AGENT_EMAIL, `/folios/${folioId}/settle`, { method: 'cash' })
    expect(status).toBe(200)
    expect(json.folio.status).toBe('paid')
    expect(json.folio.payment_verification).toBe('not_required')
    expect(json.folio.lines[0].qr_token).toBeTruthy()
    expect(await cashCollected(AGENT_EMAIL)).toBe(PRICE)
    expect(await ledgerSum(folioId, ['commission', 'commission_reversal'])).toBe(15000)
  })

  it('the apartado rules take it from there: a lapsed hold is due to the sweep again', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const folioId = await cashDepositTransferSettle(slotId)
    const pastClock = Math.floor(Date.now() / 1000) - 60
    await env.DB.prepare(`UPDATE folio_lines SET booking_expires_at = ? WHERE folio_id = ?`)
      .bind(pastClock, folioId)
      .run()

    // While it reads as paid, the sweep never looks at it.
    await sweepExpiredBookings(env)
    expect(await notificationEvents(folioId)).not.toContain('booking_grace_entered')

    await post(ADMIN_EMAIL, `/folios/${folioId}/reject`)

    // An apartado again, past its hold and still before its release instant → stage ②: the
    // customer is warned (the outbox row is written before any email is tried) and nothing is
    // released yet.
    const swept = await sweepExpiredBookings(env)
    expect(swept.cancelled).toBe(0)
    expect(await notificationEvents(folioId)).toContain('booking_grace_entered')
    expect(await bookedOf(slotId)).toBe(1)
  })

  it('per-line: a cash-settled line keeps its ticket; only the transfer line owes again', async () => {
    const { organizationId, serviceId, slotId: slotA } = await seedAgentAndAdmin()
    const slotB = await seedSlot(organizationId, serviceId, 4)
    const { json: sold } = await sell(AGENT_EMAIL, {
      payment_method: 'cash',
      down_payment: 90000,
      lines: [
        { slot_id: slotA, quantity: 1, unit_price: PRICE },
        { slot_id: slotB, quantity: 1, unit_price: PRICE },
      ],
    })
    const folioId = sold.folio.id as string
    const lineA = sold.folio.lines.find((l: any) => l.slot_id === slotA).id
    const lineB = sold.folio.lines.find((l: any) => l.slot_id === slotB).id

    const afterA = await post(AGENT_EMAIL, `/folios/${folioId}/lines/${lineA}/settle`, {
      method: 'cash',
    })
    expect(afterA.status).toBe(200)
    const ticketA = afterA.json.folio.lines.find((l: any) => l.id === lineA).qr_token
    expect(ticketA).toBeTruthy()
    const cashBeforeB = await cashCollected(AGENT_EMAIL)

    const afterB = await post(AGENT_EMAIL, `/folios/${folioId}/lines/${lineB}/settle`, {
      method: 'transfer',
      payment_reference: 'BBVA-LINEA-B',
    })
    expect(afterB.json.folio.status).toBe('paid')
    expect(afterB.json.folio.payment_verification).toBe('pending')

    const { status, json } = await post(ADMIN_EMAIL, `/folios/${folioId}/reject`)
    expect(status).toBe(200)
    expect(json.folio.status).toBe('booking')
    expect(json.folio.amount_paid).toBe(afterA.json.folio.amount_paid)
    expect(json.folio.commission_amount).toBe(afterA.json.folio.commission_amount)

    const a = json.folio.lines.find((l: any) => l.id === lineA)
    const b = json.folio.lines.find((l: any) => l.id === lineB)
    expect(a.cancelled_at ?? null).toBeNull()
    expect(a.qr_token).toBe(ticketA)
    expect(b.cancelled_at ?? null).toBeNull()
    expect(b.qr_token).toBeNull()
    expect(await bookedOf(slotA)).toBe(1)
    expect(await bookedOf(slotB)).toBe(1)
    expect(await cashCollected(AGENT_EMAIL)).toBe(cashBeforeB)
  })
})

describe('bug: reject-settle-voids-deposit — no cleared money → the sale is void, as before', () => {
  it('transfer deposit + transfer settle, both pending → cancelled, seats released', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { json: sold } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: 'BBVA-ANTICIPO',
      down_payment: DEPOSIT,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: PRICE }],
    })
    const folioId = sold.folio.id as string
    await post(AGENT_EMAIL, `/folios/${folioId}/settle`, {
      method: 'transfer',
      payment_reference: 'BBVA-SALDO',
    })

    const { status, json } = await post(ADMIN_EMAIL, `/folios/${folioId}/reject`)
    expect(status).toBe(200)
    expect(json.folio.status).toBe('cancelled')
    expect(await bookedOf(slotId)).toBe(0)
    expect(await ledgerSum(folioId, ['payment', 'refund'])).toBe(0)
    expect(await notificationEvents(folioId)).toContain('payment_rejected')
    // Neither rejected row reads as pending any more.
    const payments = json.folio.payments as Array<{ kind: string; verification: string }>
    expect(payments.filter((p) => p.kind === 'payment').map((p) => p.verification)).toEqual([
      'rejected',
      'rejected',
    ])
  })
})

describe('bug: reject-settle-voids-deposit — cross-org isolation', () => {
  it("an admin of org B cannot reject org A's settlement → 404, folio untouched", async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const serviceId = await seedService(orgA.organizationId)
    const slotId = await seedSlot(orgA.organizationId, serviceId)
    const { json: sold } = await sell(orgA.adminEmail, {
      payment_method: 'cash',
      down_payment: DEPOSIT,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: PRICE }],
    })
    const folioId = sold.folio.id as string
    await post(orgA.adminEmail, `/folios/${folioId}/settle`, {
      method: 'transfer',
      payment_reference: 'BBVA-ORG-A',
    })

    const { status } = await post(orgB.adminEmail, `/folios/${folioId}/reject`)
    expect(status).toBe(404)

    const untouched = await getFolio(orgA.adminEmail, folioId)
    expect(untouched.status).toBe('paid')
    expect(untouched.payment_verification).toBe('pending')
    expect(untouched.amount_paid).toBe(PRICE)
    expect(await bookedOf(slotId)).toBe(1)
  })
})
