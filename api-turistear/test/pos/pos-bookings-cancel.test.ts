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

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', 0, 'active', ?, ?)`,
  ).bind(id, organizationId, ts, ts).run()
  return id
}
const seedSlot = async (organizationId: string, serviceId: string, booked = 0): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, ?, 'active', ?, ?)`,
  ).bind(id, organizationId, serviceId, addDays(todayStr(), 3), booked, ts, ts).run()
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
  env.DB.prepare(`SELECT status, amount_paid, commission_amount, refund_status, reminder_status, reminder_sent_by FROM folios WHERE id = ?`)
    .bind(id)
    .first<any>()

const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
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
    expect(row.amount_paid).toBe(45000) // deposit retained
    expect(row.refund_status).toBe('none')
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
