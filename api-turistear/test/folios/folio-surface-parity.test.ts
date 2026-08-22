import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-AG59 / US-A93 / BUG-034 — the folio detail is ONE payload, read by two audiences.
// Spec: docs/oversight/folio-surface-parity.spec.md (D6, S-1…S-3, S-12, S-13).
//
// The assertion that matters here is S-3: the two detail GETs are DEEP-EQUAL. Everything the
// seller could not see before — the refund outcome, the credit, the petitions, the fulfilment
// roll-up — was missing because the payload was written twice, by hand, in two files. A parity
// test is the only thing that keeps them equal once the two copies are one function: a field
// added for one audience now reaches the other or fails here.

const AGENT_EMAIL = 'vendedora@empresa.com'
const OTHER_AGENT_EMAIL = 'otro.vendedor@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const POS = 'http://api.local/api/pos'
const FOLIOS = 'http://api.local/api/folios'
const ORGS = 'http://api.local/api/organizations'

const nowSec = () => Math.floor(Date.now() / 1000)
const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

// The spec's worked ladder: inside 5 days but before departure → half back, so a cancellation
// leaves BOTH a refund and a retention. A 0%-only ladder would make S-1 pass while showing nothing.
const HALF_BACK = {
  version: 1,
  tiers: [
    { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
    { min_hours: 0, refund_pct: 50, agent_commission_pct: 100 },
    { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
  ],
}

const seedService = async (organizationId: string): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', 1000, 'active', ?, ?)`,
  )
    .bind(id, organizationId, ts, ts)
    .run()
  return id
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  date: string,
): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = nowSec()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, date, ts, ts)
    .run()
  return id
}

const createPaidSale = async (email: string, slotId: string): Promise<string> => {
  const res = await SELF.fetch(`${POS}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({
      customer_email: 'cliente@example.com',
      customer_name: 'Cliente Test',
      customer_phone: PHONE,
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    }),
  })
  const json = (await res.json()) as any
  expect(res.status, JSON.stringify(json)).toBe(201)
  return json.folio.id
}

const sellerDetail = async (folioId: string, email = AGENT_EMAIL) => {
  const res = await SELF.fetch(`${POS}/folios/${folioId}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const adminDetail = async (folioId: string, email = ADMIN_EMAIL) => {
  const res = await SELF.fetch(`${FOLIOS}/${folioId}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const clearDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_requests')
  await env.DB.exec('DELETE FROM folio_payment_allocations')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folio_events')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
})

/** A seller and an admin in one org, with a departure three days out — inside the 50% tier. */
const seedStage = async () => {
  const agent = await seedUser({ email: AGENT_EMAIL, role: 'agent', name: 'Ana R.' })
  await seedUser({
    email: ADMIN_EMAIL,
    role: 'admin',
    name: 'Luis M.',
    organizationId: agent.organizationId,
  })
  const serviceId = await seedService(agent.organizationId)
  const slotId = await seedSlot(agent.organizationId, serviceId, addDays(todayStr(), 3))
  await SELF.fetch(`${ORGS}/me`, {
    method: 'PUT',
    headers: jsonAuth(ADMIN_EMAIL),
    body: JSON.stringify({ cancellation_policy: HALF_BACK }),
  })
  return { organizationId: agent.organizationId, agentId: agent.userId, serviceId, slotId }
}

describe('US-AG59 / BUG-034 — a cancelled sale tells the seller where the money went', () => {
  it('S-1 — the seller reads the refund and the retention, not just "pagado"', async () => {
    const stage = await seedStage()
    const folioId = await createPaidSale(AGENT_EMAIL, stage.slotId)

    const cancel = await SELF.fetch(`${FOLIOS}/${folioId}/cancel`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
      body: JSON.stringify({ reason: 'El cliente ya no viaja' }),
    })
    expect(cancel.status, JSON.stringify(await cancel.clone().json())).toBe(200)

    const { status, json } = await sellerDetail(folioId)
    expect(status).toBe(200)
    // Half of 300,000 goes back; the rest is what the company retained — the seller can now say
    // both numbers out loud. Before this, the payload carried neither.
    expect(json.folio.refund_amount).toBe(150000)
    expect(json.folio.refund_status).toBe('pending')
    expect(json.folio.amount_paid).toBe(300000)
    expect(json.folio.cancellation_reason).toBe('El cliente ya no viaja')
    expect(json.folio.cancelled_at).toBeGreaterThan(0)
  })

  it('S-2 — a credit and its expiry reach the seller', async () => {
    const stage = await seedStage()
    const folioId = await createPaidSale(AGENT_EMAIL, stage.slotId)
    // Written directly: what US-A87's close produces is not this test's subject — whether the
    // seller's payload CARRIES it is. The sweep's own arithmetic is pinned in its own suite.
    const expires = nowSec() + 90 * 86_400
    await env.DB.prepare('UPDATE folios SET credit_amount = ?, credit_expires_at = ? WHERE id = ?')
      .bind(50000, expires, folioId)
      .run()

    const { json } = await sellerDetail(folioId)
    expect(json.folio.credit_amount).toBe(50000)
    expect(json.folio.credit_expires_at).toBe(expires)
  })

  it('S-3 — the two detail payloads are identical', async () => {
    const stage = await seedStage()
    const folioId = await createPaidSale(AGENT_EMAIL, stage.slotId)

    const seller = await sellerDetail(folioId)
    const admin = await adminDetail(folioId)
    expect(seller.status).toBe(200)
    expect(admin.status).toBe(200)

    // The whole response, not a chosen subset: `folio`, `cancellation_quote` and `events`. A subset
    // would let the next field to diverge do so unobserved, which is exactly how BUG-034 happened.
    expect(seller.json).toEqual(admin.json)
    // And the fields the seller used to lack are actually present — a deep-equal of two payloads
    // that both omit a field would pass while proving nothing.
    for (const key of [
      'refund_status',
      'refund_amount',
      'refund_note',
      'credit_amount',
      'credit_expires_at',
      'cancellation_reason',
      'commission_amount',
      'pending_balance',
      'booking_expires_at',
      'fulfillment',
      'folio_requests',
      'agent',
    ]) {
      expect(seller.json.folio, `seller payload is missing ${key}`).toHaveProperty(key)
    }
    // US-A93 — the admin now sees the tickets the customer holds.
    expect(admin.json.folio.lines[0]).toHaveProperty('qr_token')
    expect(admin.json.folio.lines[0].qr).not.toBeNull()
  })
})

describe('Multitenancy and ownership — parity never widens who may read', () => {
  it('S-12 — another org\'s folio is invisible on both surfaces', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const sellerA = 'vendedor-a@empresa.com'
    const sellerB = 'vendedor-b@empresa.com'
    await seedUser({ email: sellerA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: sellerB, role: 'agent', organizationId: orgB.organizationId })
    const serviceId = await seedService(orgA.organizationId)
    const slotId = await seedSlot(orgA.organizationId, serviceId, addDays(todayStr(), 3))
    const folioId = await createPaidSale(sellerA, slotId)

    const asOtherSeller = await SELF.fetch(`${POS}/folios/${folioId}`, {
      headers: auth(sellerB),
    })
    const asOtherAdmin = await SELF.fetch(`${FOLIOS}/${folioId}`, {
      headers: auth(orgB.adminEmail),
    })
    // 404, never 403 — a 403 would confirm the folio exists.
    expect(asOtherSeller.status).toBe(404)
    expect(asOtherAdmin.status).toBe(404)
  })

  it("S-13 — another seller's folio in the SAME org is invisible", async () => {
    const stage = await seedStage()
    await seedUser({
      email: OTHER_AGENT_EMAIL,
      role: 'agent',
      name: 'Beto S.',
      organizationId: stage.organizationId,
    })
    const folioId = await createPaidSale(AGENT_EMAIL, stage.slotId)

    const foreign = await sellerDetail(folioId, OTHER_AGENT_EMAIL)
    expect(foreign.status).toBe(404)

    // …and it is absent from their list, not merely unreadable by id.
    const list = await SELF.fetch(`${POS}/folios`, { headers: auth(OTHER_AGENT_EMAIL) })
    const json = (await list.json()) as { folios: { id: string }[] }
    expect(json.folios.map((f) => f.id)).not.toContain(folioId)

    // The owner still reads it — the scope is ownership, not a blanket denial.
    const own = await sellerDetail(folioId)
    expect(own.status).toBe(200)
  })
})

describe('US-AG58 — the two LIST rows are the same row', () => {
  it('S-4 — the same folio serializes identically on both lists', async () => {
    const stage = await seedStage()
    const folioId = await createPaidSale(AGENT_EMAIL, stage.slotId)

    const sellerList = await SELF.fetch(`${POS}/folios`, { headers: auth(AGENT_EMAIL) })
    const adminList = await SELF.fetch(FOLIOS, { headers: auth(ADMIN_EMAIL) })
    const seller = (await sellerList.json()) as any
    const admin = (await adminList.json()) as any

    const mine = seller.folios.find((f: any) => f.id === folioId)
    const theirs = admin.folios.find((f: any) => f.id === folioId)
    expect(mine).toBeDefined()
    expect(theirs).toBeDefined()
    // Identical — `agent` included. What differs between the audiences is which verbs the card
    // offers and whom the byline names, both decided client-side from `surface` (D13).
    expect(mine).toEqual(theirs)
    // The three the seller's row used to omit, which the shared FolioCard reads to pick its money
    // reading — their absence is why a cancelled sale rendered a degraded figure.
    for (const key of ['refund_status', 'refund_amount', 'credit_amount', 'payment_reference']) {
      expect(mine, `seller row is missing ${key}`).toHaveProperty(key)
    }
  })

  it('S-8 — a capped list says so', async () => {
    const stage = await seedStage()
    await createPaidSale(AGENT_EMAIL, stage.slotId)
    const { json } = await (async () => {
      const res = await SELF.fetch(`${POS}/folios`, { headers: auth(AGENT_EMAIL) })
      return { json: (await res.json()) as any }
    })()
    // Below the cap: it must not claim otherwise. The cap itself is pinned in
    // test/pos/agent-folio-history.test.ts, where seeding 500 rows is cheap (no lines).
    expect(json.truncated).toBe(false)
  })
})
