import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// The public ticket page /t/:token — US-T07 (docs/pos/express-sale.spec.md S-15..S-20, S-23).
// The QR encodes `${API_BASE_URL}/t/<qr_token>` (D9): a tourist's camera lands on a MINIMAL,
// line-scoped, read-only page; the agent's scanner still redeems the same code (URL or bare).

const AGENT_EMAIL = 'agent@empresa.com'
const CUSTOMER_NAME = 'Juan Pérez Confidencial'
const PHONE = '+52 55 1234 5678'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour Cañón Amanecer', 'Punto de encuentro: muelle 3', 150000, 100000, 12, 'percent', 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, ts, ts)
    .run()
  return id
}

const seedSlot = async (organizationId: string, serviceId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '16:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, addDays(todayStr(), 3), ts, ts)
    .run()
  return id
}

// A paid cash sale minted the real way; returns the folio id + the line's raw qr_token.
const sellPaid = async (
  email: string,
  slotId: string,
  quantity = 4,
): Promise<{ folioId: string; token: string }> => {
  const res = await SELF.fetch('http://api.local/api/pos/folios', {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_name: CUSTOMER_NAME,
      customer_phone: PHONE,
      lines: [{ slot_id: slotId, quantity, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return { folioId: json.folio.id, token: json.folio.lines[0].qr_token as string }
}

const getDelivery = (folioId: string) =>
  env.DB.prepare(
    `SELECT tickets_sent_at, tickets_sent_by, tickets_viewed_at FROM folios WHERE id = ?`,
  )
    .bind(folioId)
    .first<any>()

const getRedeemed = async (folioId: string) =>
  (await env.DB.prepare(`SELECT redeemed_count FROM folio_lines WHERE folio_id = ?`)
    .bind(folioId)
    .first<{ redeemed_count: number }>())!.redeemed_count

const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-T07 — GET /t/:token', () => {
  it('S-15 — renders the minimal ticket: service + passes, and NEVER name / amount / PIN', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { folioId, token } = await sellPaid(AGENT_EMAIL, slotId)

    // Seed the fields whose leakage this page exists to prevent (D10).
    await env.DB.prepare(
      `UPDATE folios SET refund_status = 'pending', refund_pin = '481902' WHERE id = ?`,
    )
      .bind(folioId)
      .run()

    const res = await SELF.fetch(`http://api.local/t/${token}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Tour Cañón Amanecer')
    expect(html).toContain('4 personas')
    expect(html).toContain('portal-qr') // the QR is on the page
    // D10 — the three exclusions that ARE the security decision:
    expect(html).not.toContain(CUSTOMER_NAME)
    expect(html).not.toContain('481902')
    expect(html).not.toMatch(/Total|6,000|600000/)
  })

  it('S-16 — viewing never redeems', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { folioId, token } = await sellPaid(AGENT_EMAIL, slotId)

    for (let i = 0; i < 3; i++) {
      const res = await SELF.fetch(`http://api.local/t/${token}`)
      expect(res.status).toBe(200)
    }
    expect(await getRedeemed(folioId)).toBe(0)
  })

  it('S-17 — a cancelled folio shows no QR', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { folioId, token } = await sellPaid(AGENT_EMAIL, slotId)
    await env.DB.prepare(`UPDATE folios SET status = 'cancelled' WHERE id = ?`)
      .bind(folioId)
      .run()

    const res = await SELF.fetch(`http://api.local/t/${token}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('cancelado')
    expect(html).not.toContain('portal-qr')
  })

  it('S-18 — a tampered token and garbage are the same generic 404', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { token } = await sellPaid(AGENT_EMAIL, slotId)

    // Flip one payload character (base64url) — signature must fail.
    const dot = token.indexOf('.')
    const flipped =
      (token[0] === 'A' ? 'B' : 'A') + token.slice(1, dot) + token.slice(dot)
    const tampered = await SELF.fetch(`http://api.local/t/${flipped}`)
    expect(tampered.status).toBe(404)

    const garbage = await SELF.fetch(`http://api.local/t/not-a-token`)
    expect(garbage.status).toBe(404)
  })

  it('S-19 — the beacon sets BOTH sent and viewed; sent_by stays null; idempotent', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { folioId, token } = await sellPaid(AGENT_EMAIL, slotId)

    const before = await getDelivery(folioId)
    expect(before.tickets_sent_at).toBeNull()

    const res = await SELF.fetch(`http://api.local/t/${token}/seen`, { method: 'POST' })
    expect(res.status).toBe(204)

    const after = await getDelivery(folioId)
    expect(after.tickets_sent_at).not.toBeNull()
    expect(after.tickets_viewed_at).not.toBeNull()
    // Known behaviour 4 — a counter handoff has no sending agent.
    expect(after.tickets_sent_by).toBeNull()

    // First write wins — a second beacon does not move the timestamps.
    await SELF.fetch(`http://api.local/t/${token}/seen`, { method: 'POST' })
    const again = await getDelivery(folioId)
    expect(again.tickets_sent_at).toBe(after.tickets_sent_at)
    expect(again.tickets_viewed_at).toBe(after.tickets_viewed_at)
  })

  it('S-20 — the scanner redeems BOTH encodings: bare token and /t/<token> URL', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const { token } = await sellPaid(AGENT_EMAIL, slotId, 2)

    const scan = async (payload: string) => {
      const res = await SELF.fetch('http://api.local/api/tickets/scan', {
        method: 'POST',
        headers: jsonAuth(AGENT_EMAIL),
        body: JSON.stringify({ token: payload }),
      })
      return (await res.json()) as any
    }

    const bare = await scan(token)
    expect(bare.result, JSON.stringify(bare)).toBe('valid')
    expect(bare.ticket.pass_number).toBe(1)

    const url = await scan(`https://api.example.com/t/${token}`)
    expect(url.result).toBe('valid')
    expect(url.ticket.pass_number).toBe(2)
  })

  it('S-23 — a foreign org token still fails the scanner (caller-org key unchanged)', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId: orgA.organizationId })
    const serviceId = await seedService(orgA.organizationId)
    const slotId = await seedSlot(orgA.organizationId, serviceId)
    const { token } = await sellPaid(AGENT_EMAIL, slotId)

    const res = await SELF.fetch('http://api.local/api/tickets/scan', {
      method: 'POST',
      headers: jsonAuth(orgB.adminEmail),
      body: JSON.stringify({ token }),
    })
    const json = (await res.json()) as any
    expect(json.result).toBe('invalid')
    expect(json.reason).toBe('INVALID_SIGNATURE')
  })
})
