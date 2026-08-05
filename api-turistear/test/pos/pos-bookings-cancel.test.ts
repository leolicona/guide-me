import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Bookings / down-payments — manual cancel + reminder claim + dashboard row (US-AG07.3, .4).
// Spec: docs/bookings/bookings-down-payments.spec.md §7 (Sc.10, 14, 14b, 16).

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const base = 'http://api.local/api/pos'

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (
  organizationId: string,
  // Basis points of percent commission. 0 keeps the older cases free of commission arithmetic.
  commissionValue = 0,
): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', ?, 'active', ?, ?)`,
  ).bind(id, organizationId, commissionValue, ts, ts).run()
  return id
}
// `daysOut` places the departure relative to today at 06:00. It decides which tier of the inherited
// ladder a cancellation lands in, so it is the knob these tests turn: 3 days ≈ 62–72h (the 50%
// tier), 7 days ≈ 158–168h (the 100% tier). Both stay well inside their band whatever hour the
// suite runs at, which is deliberate — a departure pinned near a boundary makes the test's outcome
// depend on the clock.
const seedSlot = async (
  organizationId: string,
  serviceId: string,
  booked = 0,
  daysOut = 3,
): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, ?, 'active', ?, ?)`,
  ).bind(id, organizationId, serviceId, addDays(todayStr(), daysOut), booked, ts, ts).run()
  return id
}
const createBooking = async (email: string, slotId: string, quantity = 2): Promise<string> => {
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_email: 'c@example.com',
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}
const cancel = async (email: string, id: string, reason?: string) => {
  const res = await SELF.fetch(`${base}/folios/${id}/cancel`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ reason }),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const reminder = async (email: string, id: string, force = false) => {
  const res = await SELF.fetch(`${base}/folios/${id}/reminder`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ force }),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const getSlotBooked = async (id: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(id).first<{ booked: number }>())!.booked
const getFolio = (id: string) =>
  env.DB.prepare(
    `SELECT status, amount_paid, commission_amount, refund_status, refund_amount, refund_pin,
            cancellation_source, cancellation_clawback, reminder_status, reminder_sent_by
     FROM folios WHERE id = ?`,
  )
    .bind(id)
    .first<any>()

// What the folio still contributes to the books. The paid-ledger stores SIGNED movement rows, so a
// cancellation writes negative `refund` / `commission_reversal` rows against the positive
// `payment` / `commission` ones and the answer is the sum — grouping by entry_type instead would
// report the accrual alone and call a fully-reversed commission "4500". Netted exactly the way
// `buildCancellationReversal` reads its buckets, which is what the cash-drop report sees.
const ledgerNet = async (folioId: string): Promise<{ money: number; commission: number }> => {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN entry_type IN ('payment','refund') THEN amount END), 0) AS money,
       COALESCE(SUM(CASE WHEN entry_type IN ('commission','commission_reversal') THEN amount END), 0) AS commission
     FROM folio_payments WHERE folio_id = ?`,
  )
    .bind(folioId)
    .first<{ money: number; commission: number }>()
  return { money: Number(row!.money), commission: Number(row!.commission) }
}

const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-AG07.4 — manual cancel', () => {
  it('Sc.10 — cancel releases spots, retains the deposit, keeps commission', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking(AGENT_EMAIL, slotId, 2)
    expect(await getSlotBooked(slotId)).toBe(2)

    const { status, json } = await cancel(AGENT_EMAIL, folioId, 'Cliente desistió')
    expect(status).toBe(200)
    expect(json.folio.status).toBe('cancelled')
    expect(await getSlotBooked(slotId)).toBe(0) // spots released

    const row = await getFolio(folioId)
    expect(row.status).toBe('cancelled')
    expect(row.amount_paid).toBe(45000)
    // The deposit is retained here, but NOT because deposits have a rule (D20 deleted that). The
    // departure is ~62–72h out, which lands in the inherited ladder's 50% tier: the company retains
    // half of the 300,000 sale = 150,000, and the customer only ever paid 45,000, so there is
    // nothing left to give back. The arithmetic, not a deposit clause.
    expect(row.refund_status).toBe('none')
    expect(json.cancellation).toMatchObject({ refund: 0, retention: 45000 })
    expect(row.cancellation_source).toBe('agent')
  })

  // D20 — the case that did not exist before: far enough out, the ladder refunds the deposit, and an
  // agent's cancel now opens a real obligation against their drawer. This is the behaviour change
  // the whole task was for, so it is asserted end to end.
  it('an apartado cancelled beyond the top tier refunds the deposit in full', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, 0, 7) // ~158–168h out → 100% tier
    const folioId = await createBooking(AGENT_EMAIL, slotId, 2)

    const { status, json } = await cancel(AGENT_EMAIL, folioId, 'Cliente reprogramó')
    expect(status).toBe(200)
    expect(json.cancellation).toMatchObject({ refund: 45000, retention: 0 })
    expect(await getSlotBooked(slotId)).toBe(0)

    const row = await getFolio(folioId)
    expect(row.refund_status).toBe('pending')
    expect(row.refund_amount).toBe(45000)
    // A tourist owed cash must be able to prove they were present to collect it, whoever cancelled.
    expect(row.refund_pin).toMatch(/^\d{6}$/)

    // The money leaves the books because it genuinely leaves the drawer.
    expect(await ledgerNet(folioId)).toEqual({ money: 0, commission: 0 })
  })

  // The cash leak this replaced: `cancelBooking` reversed the collected money IN FULL regardless of
  // what was retained, so the ledger netted to zero while 45,000 pesos sat in the agent's pocket and
  // no cash-drop report ever asked for them. The reversal is proportional to the refund now, so a
  // retained deposit stays visible as money the company is owed.
  it('a retained deposit stays on the books — the reversal is proportional, not total', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId) // 3 days out → nothing refunded
    const folioId = await createBooking(AGENT_EMAIL, slotId, 2)

    expect((await cancel(AGENT_EMAIL, folioId)).status).toBe(200)

    // 45,000 the company is owed, still on the books. The old path netted this to zero.
    expect((await ledgerNet(folioId)).money).toBe(45000)
  })

  // D20 + decision 7 — commission follows the same tier. Beyond 120h the inherited ladder pays the
  // agent nothing on a cancelled sale, so the accrued commission is clawed back; the old path handed
  // it over unconditionally (`clawback: false`, hard-coded).
  it('commission follows the tier: clawed back on an early cancel', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId, 1000) // 10%
    const slotId = await seedSlot(organizationId, serviceId, 0, 7)
    const folioId = await createBooking(AGENT_EMAIL, slotId, 2)

    const { json } = await cancel(AGENT_EMAIL, folioId)
    expect(json.cancellation.kept_commission).toBe(0)
    // 4,500 — 10% of the 45,000 actually COLLECTED, not 10% of the 300,000 sale. An apartado accrues
    // commission on the deposit (US-AG07), so deriving the figure from the lines told the agent they
    // were losing 30,000 they had never earned. `lineCommissions` reconciles to what the folio booked.
    expect(json.cancellation.reversed_commission).toBe(4500)

    const row = await getFolio(folioId)
    expect(row.cancellation_clawback).toBe(1)
    expect((await ledgerNet(folioId)).commission).toBe(0) // accrued, then fully reversed
  })

  // US-A76 (#12) — the POS folio read carries what cancelling now would cost, so the confirm sheet
  // states the refund instead of asserting one. The number must be the number the cancel writes,
  // which is why both come from `quoteCancellation` rather than being re-derived on the client.
  it('the folio detail quotes the cancellation, and the quote is what cancelling pays', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, 0, 7) // 100% tier
    const folioId = await createBooking(AGENT_EMAIL, slotId, 2)

    const detail = await SELF.fetch(`${base}/folios/${folioId}`, { headers: auth(AGENT_EMAIL) })
    const { cancellation_quote: quote } = (await detail.json()) as any
    expect(quote).toMatchObject({ refund: 45000, retention: 0 })

    const { json } = await cancel(AGENT_EMAIL, folioId)
    expect(json.cancellation.refund).toBe(quote.refund)

    // Nothing left to quote once it is cancelled — a stale figure beside a cancelled folio is
    // worse than none.
    const after = await SELF.fetch(`${base}/folios/${folioId}`, { headers: auth(AGENT_EMAIL) })
    expect(((await after.json()) as any).cancellation_quote).toBeNull()
  })

  it('cancel rejects a non-booking (paid / already cancelled) → 409', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking(AGENT_EMAIL, slotId)
    await SELF.fetch(`${base}/folios/${folioId}/settle`, { method: 'POST', headers: jsonAuth(AGENT_EMAIL) })
    const after = await cancel(AGENT_EMAIL, folioId)
    expect(after.status).toBe(409)
    expect(after.json.error.code).toBe('NOT_A_BOOKING')
  })
})

describe('US-AG07.3 — reminder claim + dashboard', () => {
  it('Sc.14 / 14b — atomic claim: first wins, the admin loses, force re-claims', async () => {
    const { userId: agentId, organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const { userId: adminId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin', organizationId })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const folioId = await createBooking(AGENT_EMAIL, slotId)

    // Owner agent claims first.
    const first = await reminder(AGENT_EMAIL, folioId)
    expect(first.status).toBe(200)
    expect(first.json.claimed).toBe(true)
    expect((await getFolio(folioId)).reminder_status).toBe('sent')

    // Admin (org-wide) loses the claim → gets the agent's stamp.
    const second = await reminder(ADMIN_EMAIL, folioId)
    expect(second.json.claimed).toBe(false)
    expect(second.json.reminder_sent_by).toBe(agentId)

    // Force re-claims for the admin.
    const forced = await reminder(ADMIN_EMAIL, folioId, true)
    expect(forced.json.claimed).toBe(true)
    expect((await getFolio(folioId)).reminder_sent_by).toBe(adminId)
  })

  it('dashboard row exposes pending_balance, booking_expires_at, reminder_status', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    await createBooking(AGENT_EMAIL, slotId, 2)

    const res = await SELF.fetch(`${base}/folios?status=booking`, { headers: auth(AGENT_EMAIL) })
    const body = (await res.json()) as { folios: any[] }
    expect(body.folios).toHaveLength(1)
    expect(body.folios[0]).toMatchObject({
      status: 'booking',
      total: 300000,
      amount_paid: 45000,
      pending_balance: 255000,
      reminder_status: 'none',
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
    })
    expect(body.folios[0].booking_expires_at).toBeGreaterThan(0)
  })

  it('Sc.16 — B4 isolation: foreign agent cannot cancel or remind', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: agentB, role: 'agent', organizationId: orgB.organizationId })
    const serviceId = await seedService(orgA.organizationId)
    const slotId = await seedSlot(orgA.organizationId, serviceId)
    const folioId = await createBooking(agentA, slotId)

    expect((await cancel(agentB, folioId)).status).toBe(404)
    expect((await reminder(agentB, folioId)).status).toBe(404)
    expect((await getFolio(folioId)).status).toBe('booking') // untouched
  })
})
