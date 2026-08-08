import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A88 — the transfer-reference requirement becomes an org setting (payment-verification D10,
// amending D2). Default ON preserves US-AG41's rule byte-for-byte — the pre-feature suites
// (payment-verification.test.ts, settle-method.test.ts) must keep passing UNEDITED; this file only
// covers the opt-out. The invariant under test throughout: relaxing the reference NEVER relaxes
// verification — an unreferenced transfer still lands `pending` with its QR deferred (US-A67).

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
     VALUES (?, ?, 'Tour', NULL, 150000, 100000, 12, 'percent', 1000, 'active', ?, ?)`,
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
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, 0, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, addDays(todayStr(), 3), ts, ts)
    .run()
  return id
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

const settle = async (email: string, folioId: string, body?: Record<string, unknown>) => {
  const res = await SELF.fetch(`${base}/folios/${folioId}/settle`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any }
}

const putOrg = async (email: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch('http://api.local/api/organizations/me', {
    method: 'PUT',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const seedAgentAndAdmin = async () => {
  const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  const serviceId = await seedService(organizationId)
  const slotId = await seedSlot(organizationId, serviceId)
  return { organizationId, serviceId, slotId }
}

const clearPosDb = async () => {
  for (const t of [
    'folio_line_extras',
    'folio_lines',
    'folio_access_tokens',
    'accommodation_reservations',
    'folio_payments',
    'notifications',
    'folio_events', 'folios',
    'slots',
    'services',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-A88 — the org setting itself', () => {
  it('defaults to required and round-trips through PUT /organizations/me', async () => {
    await seedAgentAndAdmin()
    const before = await SELF.fetch('http://api.local/api/organizations/me', {
      headers: auth(ADMIN_EMAIL),
    })
    expect(((await before.json()) as any).organization.payment_reference_required).toBe(true)

    const { status, json } = await putOrg(ADMIN_EMAIL, { payment_reference_required: false })
    expect(status).toBe(200)
    expect(json.organization.payment_reference_required).toBe(false)
  })

  it('an agent may not flip it (admin-only PUT)', async () => {
    await seedAgentAndAdmin()
    const { status } = await putOrg(AGENT_EMAIL, { payment_reference_required: false })
    expect(status).toBe(403)
  })
})

describe('US-A88 — confirm: transfer without a reference', () => {
  it('still 400 while the requirement is on (the default)', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { status } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(400)
  })

  it('with the requirement off → 201, but STILL pending with no QR and no portal link', async () => {
    const { slotId } = await seedAgentAndAdmin()
    await putOrg(ADMIN_EMAIL, { payment_reference_required: false })

    const { status, json } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status, JSON.stringify(json)).toBe(201)
    expect(json.folio.status).toBe('paid')
    // The verification axis (US-A67) is untouched by the opt-out: the money is still unconfirmed.
    expect(json.folio.payment_verification).toBe('pending')
    expect(json.folio.payment_reference).toBeNull()
    expect(json.folio.lines[0].qr_token).toBeNull()
    expect(json.folio.portal_link).toBeNull()
  })

  it('with the requirement off, a reference is still accepted and stored when given', async () => {
    const { slotId } = await seedAgentAndAdmin()
    await putOrg(ADMIN_EMAIL, { payment_reference_required: false })

    const { status, json } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: 'BBVA-0099887766',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(json.folio.payment_reference).toBe('BBVA-0099887766')
    expect(json.folio.payment_verification).toBe('pending')
  })
})

describe('US-A88 — settle: transfer balance without a reference', () => {
  const book = async (slotId: string): Promise<string> => {
    const { status, json } = await sell(AGENT_EMAIL, {
      payment_method: 'cash',
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }], // total 300000
    })
    expect(status, JSON.stringify(json)).toBe(201)
    return json.folio.id
  }

  it('still 400 while the requirement is on (the default)', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const folioId = await book(slotId)
    const s = await settle(AGENT_EMAIL, folioId, { method: 'transfer' })
    expect(s.status).toBe(400)
  })

  it('with the requirement off → settles, re-arms pending, defers the QR until verify', async () => {
    const { slotId } = await seedAgentAndAdmin()
    await putOrg(ADMIN_EMAIL, { payment_reference_required: false })
    const folioId = await book(slotId)

    const s = await settle(AGENT_EMAIL, folioId, { method: 'transfer' })
    expect(s.status, JSON.stringify(s.json)).toBe(200)
    expect(s.json.folio.status).toBe('paid')
    expect(s.json.folio.lines[0].qr_token ?? null).toBeNull() // deferred — money unconfirmed

    const balance = (await env.DB.prepare(
      `SELECT method, reference, verification FROM folio_payments WHERE folio_id = ? AND entry_type = 'payment' AND amount = 255000`,
    )
      .bind(folioId)
      .first()) as Record<string, unknown>
    expect(balance).toMatchObject({ method: 'transfer', reference: null, verification: 'pending' })

    // The admin can still verify (against amount/date — there is just no reference to match).
    const v = await SELF.fetch(`${base}/folios/${folioId}/verify`, {
      method: 'POST',
      headers: jsonAuth(ADMIN_EMAIL),
    })
    expect(v.status).toBe(200)
  })
})

describe('US-A88 — cross-org isolation', () => {
  it("org B opting out never relaxes org A's requirement", async () => {
    // Two sibling orgs, seeded by hand (seedTwoOrgs seeds admins only; we need an agent + slot).
    const { organizationId: orgA } = await seedUser({ email: 'admin-a@a.com', role: 'admin' })
    await seedUser({ email: 'agent-a@a.com', role: 'agent', organizationId: orgA })
    const slotA = await seedSlot(orgA, await seedService(orgA))
    const { organizationId: orgB } = await seedUser({
      email: 'admin-b@b.com',
      role: 'admin',
      organizationName: 'Empresa B',
    })
    void orgB

    await putOrg('admin-b@b.com', { payment_reference_required: false })

    // Org A's agent still faces the requirement.
    const { status } = await sell('agent-a@a.com', {
      payment_method: 'transfer',
      lines: [{ slot_id: slotA, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(400)
  })
})
