import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import { sweepExpiredBookings } from '../../src/routes/pos/sweep'

// BUG-030 — cancelling while a transfer awaits verification minted a refund PIN for money the
// company never confirmed: `cancelFolio` priced the ladder over `amount_paid`, which counts the
// unconfirmed transfer. Both human entrances now refuse with PAYMENT_UNVERIFIED; `rejectPayment`
// stays the cancel path for unconfirmed money, and the SWEEP stays untouched — an expired hold
// releases its seats regardless of what the money is still waiting on.

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const POS = 'http://api.local/api/pos'
const FOLIOS = 'http://api.local/api/folios'

const nowSec = () => Math.floor(Date.now() / 1000)
const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (organizationId: string): Promise<string> => {
  const serviceId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', 0, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, ts, ts)
    .run()
  return serviceId
}

const seedSlot = async (organizationId: string, serviceId: string): Promise<string> => {
  const slotId = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, addDays(todayStr(), 3), ts, ts)
    .run()
  return slotId
}

const confirm = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_email: 'cliente@example.com',
      customer_name: 'Cliente Test',
      customer_phone: '+52 55 1234 5678',
      ...body,
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}

const post = async (email: string, url: string, body?: unknown) => {
  const res = await SELF.fetch(url, {
    method: 'POST',
    headers: jsonAuth(email),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const getFolio = (id: string) =>
  env.DB.prepare(
    `SELECT f.*,
      (SELECT CASE
        WHEN COALESCE(SUM(CASE WHEN fl.cancelled_at IS NULL THEN 1 ELSE 0 END),0) = 0 THEN 'cancelled'
        WHEN COALESCE(SUM(CASE WHEN fl.cancelled_at IS NULL
            AND COALESCE((SELECT SUM(a2.amount) FROM folio_payment_allocations a2 WHERE a2.folio_line_id = fl.id),0) < fl.line_total
            THEN 1 ELSE 0 END),0) > 0 THEN 'booking'
        ELSE 'paid' END
       FROM folio_lines fl WHERE fl.folio_id = f.id) AS status,
      (SELECT COALESCE(
        (SELECT MIN(fl.booking_expires_at) FROM folio_lines fl
          WHERE fl.folio_id = f.id AND fl.cancelled_at IS NULL AND fl.booking_expires_at IS NOT NULL),
        (SELECT MIN(fl.booking_expires_at) FROM folio_lines fl
          WHERE fl.folio_id = f.id AND fl.booking_expires_at IS NOT NULL))) AS booking_expires_at,
      (SELECT CASE
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'pending') THEN 'pending'
        WHEN EXISTS (SELECT 1 FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status = 'refunded') THEN 'refunded'
        ELSE 'none' END) AS refund_status,
      (SELECT SUM(fl.refund_amount) FROM folio_lines fl WHERE fl.folio_id = f.id AND fl.refund_status <> 'none') AS refund_amount
     FROM folios f WHERE f.id = ?`,
  )
    .bind(id)
    .first<{ status: string; refund_status: string; refund_amount: number | null; refund_pin: string | null }>()

const clearDb = async () => {
  for (const t of [
    'folio_line_extras', 'folio_requests', 'folio_lines', 'folio_access_tokens',
    'folio_payments', 'notifications', 'folio_events', 'folios', 'slots', 'services',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

const seedStage = async () => {
  const agent = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
  await seedUser({ email: ADMIN_EMAIL, role: 'admin', organizationId: agent.organizationId })
  const serviceId = await seedService(agent.organizationId)
  const slotId = await seedSlot(agent.organizationId, serviceId)
  return { slotId }
}

describe('BUG-030 — no cancellation may price money the company never confirmed', () => {
  it('the admin cancel refuses an unverified-transfer folio; no refund PIN exists after', async () => {
    const { slotId } = await seedStage()
    const folioId = await confirm(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: 'SPEI 1234',
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })

    const res = await post(ADMIN_EMAIL, `${FOLIOS}/${folioId}/cancel`, { reason: 'test' })
    expect(res.status).toBe(409)
    expect(res.json?.error?.code ?? res.json?.code).toBe('PAYMENT_UNVERIFIED')

    const row = await getFolio(folioId)
    expect(row).toMatchObject({ status: 'paid', refund_status: 'none', refund_pin: null })
  })

  it("the agent's apartado cancel refuses an unverified transfer deposit", async () => {
    const { slotId } = await seedStage()
    const folioId = await confirm(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: 'SPEI 5678',
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })

    const res = await post(AGENT_EMAIL, `${POS}/folios/${folioId}/cancel`)
    expect(res.status).toBe(409)
    expect(res.json?.error?.code ?? res.json?.code).toBe('PAYMENT_UNVERIFIED')
    expect((await getFolio(folioId))!.status).toBe('booking')
  })

  it('once verified, the same cancel succeeds and prices normally', async () => {
    const { slotId } = await seedStage()
    const folioId = await confirm(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: 'SPEI 9999',
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })

    const verified = await post(ADMIN_EMAIL, `${POS}/folios/${folioId}/verify`)
    expect(verified.status).toBe(200)

    const res = await post(ADMIN_EMAIL, `${FOLIOS}/${folioId}/cancel`, { reason: 'test' })
    expect(res.status).toBe(200)
    expect((await getFolio(folioId))!.status).toBe('cancelled')
  })

  it('rejectPayment remains the cancel path for unconfirmed money — no refund obligation', async () => {
    const { slotId } = await seedStage()
    const folioId = await confirm(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: 'SPEI 4471',
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })

    const res = await post(ADMIN_EMAIL, `${POS}/folios/${folioId}/reject`, { reason: 'No llegó' })
    expect(res.status).toBe(200)
    const row = await getFolio(folioId)
    expect(row).toMatchObject({ status: 'cancelled', refund_status: 'none' })
  })

  it('the sweep still cancels an expired hold whose deposit is unverified — seats do not wait on money', async () => {
    const { slotId } = await seedStage()
    const folioId = await confirm(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: 'SPEI 0001',
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })
    // Past the grace instant (the pos-bookings-sweep pattern): the line's snapshotted departure
    // moves to now, and the hold's release timestamp is in the past.
    const now = new Date()
    await env.DB.prepare(`UPDATE folio_lines SET slot_date = ?, slot_start_time = ? WHERE folio_id = ?`)
      .bind(now.toISOString().slice(0, 10), now.toISOString().slice(11, 16), folioId)
      .run()
    await env.DB.prepare(`UPDATE folios SET booking_expires_at = ? WHERE id = ?`)
      .bind(nowSec() - 60, folioId)
      .run()
    // Since line-autonomy F3 (D5) elapsed time lives in the LINE's clock too.
    await env.DB.prepare(`UPDATE folio_lines SET booking_expires_at = ? WHERE folio_id = ?`)
      .bind(nowSec() - 60, folioId)
      .run()

    const result = await sweepExpiredBookings(env)
    expect(result).toMatchObject({ failed: 0 })
    expect((await getFolio(folioId))!.status).toBe('cancelled')
  })
})
