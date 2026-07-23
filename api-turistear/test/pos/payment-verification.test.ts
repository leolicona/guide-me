import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-AG41 / US-A67 — record a transfer reference + admin verification before QR release.
// Spec: docs/payment-verification/spec.md. The suite clock is frozen (see apply-migrations.ts); a
// slot 3 days out is always sellable, so cutoff never interferes.

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'
const PHONE = '+52 55 1234 5678'
const REF = 'BBVA-0099887766'
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

const seedSlot = async (organizationId: string, serviceId: string, booked = 0): Promise<string> => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '06:00', 12, ?, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, addDays(todayStr(), 3), booked, ts, ts)
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

const bookedOf = async (slotId: string): Promise<number> =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(slotId).first<{ booked: number }>())!.booked

const seedAgentAndAdmin = async () => {
  const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
  await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
  const serviceId = await seedService(organizationId)
  const slotId = await seedSlot(organizationId, serviceId)
  return { organizationId, serviceId, slotId }
}

const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM accommodation_reservations')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

describe('US-AG41 — record method + transfer reference', () => {
  it('a transfer sale WITHOUT a reference → 400', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { status } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(400)
  })

  it('a cash sale clears immediately: verification not_required + QR issued', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { status, json } = await sell(AGENT_EMAIL, {
      payment_method: 'cash',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(json.folio.payment_verification).toBe('not_required')
    expect(json.folio.lines[0].qr_token).toBeTruthy()
    expect(json.folio.portal_link).toBeTruthy()
  })
})

describe('US-A67 — full transfer sale: pending → verify releases QR', () => {
  it('a transfer sale is paid+pending with NO QR and no portal link', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { status, json } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: REF,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(json.folio.status).toBe('paid')
    expect(json.folio.payment_verification).toBe('pending')
    expect(json.folio.payment_reference).toBe(REF)
    expect(json.folio.lines[0].qr_token).toBeNull()
    expect(json.folio.portal_link).toBeNull()
  })

  it('admin verify → verified, QR signed, portal link minted', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { json: sold } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: REF,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    const { status, json } = await post(ADMIN_EMAIL, `/folios/${sold.folio.id}/verify`)
    expect(status).toBe(200)
    expect(json.folio.payment_verification).toBe('verified')
    expect(json.folio.payment_verified_at).toBeTruthy()
    expect(json.folio.lines[0].qr_token).toBeTruthy()
    expect(json.folio.portal_link).toBeTruthy()
  })

  it('an agent may NOT verify (admin-only) → 403', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { json: sold } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: REF,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    const { status } = await post(AGENT_EMAIL, `/folios/${sold.folio.id}/verify`)
    expect(status).toBe(403)
  })

  it('verifying a non-pending (cash) folio → 409', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { json: sold } = await sell(AGENT_EMAIL, {
      payment_method: 'cash',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    const { status } = await post(ADMIN_EMAIL, `/folios/${sold.folio.id}/verify`)
    expect(status).toBe(409)
  })
})

describe('US-A67 — reject voids the sale', () => {
  it('reject → folio cancelled, held spots released', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { json: sold } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: REF,
      lines: [{ slot_id: slotId, quantity: 3, unit_price: 150000 }],
    })
    expect(await bookedOf(slotId)).toBe(3)
    const { status, json } = await post(ADMIN_EMAIL, `/folios/${sold.folio.id}/reject`, {
      reason: 'No llegó la transferencia',
    })
    expect(status).toBe(200)
    expect(json.folio.status).toBe('cancelled')
    expect(await bookedOf(slotId)).toBe(0)
  })
})

describe('US-A67 — transfer deposit + transfer settle (re-armable axis)', () => {
  it('a transfer deposit is pending; verifying it mints no QR (still a booking)', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { status, json } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: REF,
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)
    expect(json.folio.status).toBe('booking')
    expect(json.folio.payment_verification).toBe('pending')

    const verified = await post(ADMIN_EMAIL, `/folios/${json.folio.id}/verify`)
    expect(verified.status).toBe(200)
    expect(verified.json.folio.payment_verification).toBe('verified')
    expect(verified.json.folio.status).toBe('booking')
    expect(verified.json.folio.lines[0].qr_token).toBeNull()
  })

  it('settling a transfer booking requires a reference, re-arms pending, and verify signs QR', async () => {
    const { slotId } = await seedAgentAndAdmin()
    const { json: booked } = await sell(AGENT_EMAIL, {
      payment_method: 'transfer',
      payment_reference: REF,
      down_payment: 45000,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    await post(ADMIN_EMAIL, `/folios/${booked.folio.id}/verify`) // clear the deposit

    // Settle without a reference → 400.
    const noRef = await post(AGENT_EMAIL, `/folios/${booked.folio.id}/settle`)
    expect(noRef.status).toBe(400)

    // Settle with a reference → paid but re-armed to pending, no QR yet.
    const settled = await post(AGENT_EMAIL, `/folios/${booked.folio.id}/settle`, {
      payment_reference: 'BBVA-SETTLE-1234',
    })
    expect(settled.status).toBe(200)
    expect(settled.json.folio.status).toBe('paid')
    expect(settled.json.folio.payment_verification).toBe('pending')
    expect(settled.json.folio.lines[0].qr_token).toBeNull()

    // Admin verifies the settlement → QR signed.
    const verified = await post(ADMIN_EMAIL, `/folios/${booked.folio.id}/verify`)
    expect(verified.status).toBe(200)
    expect(verified.json.folio.payment_verification).toBe('verified')
    expect(verified.json.folio.lines[0].qr_token).toBeTruthy()
  })
})

describe('US-A67 — cross-org isolation (B3)', () => {
  it('an admin cannot verify another org’s folio → 404', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    // Sell a transfer folio in org A (via A's admin as seller).
    const serviceId = await seedService(orgA.organizationId)
    const slotId = await seedSlot(orgA.organizationId, serviceId)
    const { json: sold } = await sell(orgA.adminEmail, {
      payment_method: 'transfer',
      payment_reference: REF,
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    // Org B's admin tries to verify it.
    const { status } = await post(orgB.adminEmail, `/folios/${sold.folio.id}/verify`)
    expect(status).toBe(404)
    // And it stays pending in org A.
    const stillPending = await getFolio(orgA.adminEmail, sold.folio.id)
    expect(stillPending.payment_verification).toBe('pending')
  })
})
