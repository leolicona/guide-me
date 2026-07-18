import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

const AGENT_EMAIL = 'agent@empresa.com'
const ADMIN_EMAIL = 'admin@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM cancellation_requests')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM cancellation_requests')
  await env.DB.exec('DELETE FROM folio_access_tokens')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

// Minimal Seeders
const seedService = async (orgId: string, name = 'Tour') => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_value, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 150000, 100000, 12, 0, 'active', ?, ?)`
  ).bind(id, orgId, name, ts, ts).run()
  return { id }
}

const seedSlot = async (orgId: string, svcId: string, cap = 12) => {
  const id = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at) VALUES (?, ?, ?, NULL, '2026-06-15', '10:00', ?, 0, 'active', ?, ?)`
  ).bind(id, orgId, svcId, cap, ts, ts).run()
  return { id }
}

const confirmSale = async (email: string, body: any) => {
  return SELF.fetch('http://api.local/api/pos/folios', {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
}

const cancelFolio = async (email: string, folioId: string, body: any) => {
  return SELF.fetch(`http://api.local/api/folios/${folioId}/cancel`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
}

let resendCalls: { to: string; subject: string; html: string }[] = []
let mockFetchOk = true

const originalFetch = globalThis.fetch
const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url ?? String(input)
  if (url.includes('resend.com')) {
    if (!mockFetchOk) {
      return new Response('Mock Error', { status: 500 })
    }
    const body = JSON.parse((init?.body as string) ?? '{}')
    resendCalls.push({ to: body.to, subject: body.subject, html: body.html })
    return new Response(JSON.stringify({ id: 'mock-id' }), { status: 200 })
  }
  return originalFetch(input, init)
})

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
  resendCalls = []
  mockFetchOk = true
  vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch as any)
  // ensure we have a key
  env.RESEND_API_KEY = 'test-key'
  env.RESEND_FROM = 'no-reply@turistearya.com'
})
afterEach(() => vi.restoreAllMocks())

describe('US-AG09 / US-C01 — Confirmation Email', () => {
  it('Scenario 1 & 4 — Confirmation email sent with QR codes (multi-line)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const svc1 = await seedService(organizationId, 'Tour A')
    const slot1 = await seedSlot(organizationId, svc1.id)
    const svc2 = await seedService(organizationId, 'Tour B')
    const slot2 = await seedSlot(organizationId, svc2.id)

    const res = await confirmSale(AGENT_EMAIL, {
      customer_email: 'juan@example.com',
      customer_name: 'Juan Perez',
      lines: [
        { slot_id: slot1.id, quantity: 1, unit_price: 150000 },
        { slot_id: slot2.id, quantity: 2, unit_price: 150000 },
      ]
    })
    expect(res.status).toBe(201)
    const json = await res.json() as any

    expect(resendCalls).toHaveLength(1)
    const call = resendCalls[0]
    expect(call.to).toBe('juan@example.com')
    expect(call.subject).toContain('Empresa')
    expect(call.html).toContain('qrserver.com')
    // 2 lines, so 2 qr tokens
    expect(call.html).toContain(encodeURIComponent(json.folio.lines[0].qr_token))
    expect(call.html).toContain(encodeURIComponent(json.folio.lines[1].qr_token))
    expect(call.html).toContain('Tour A')
    expect(call.html).toContain('Tour B')
  })

  it('Scenario 2 — Sale without customer_email is rejected (400); no Resend call', async () => {
    // customer_email is now mandatory at POS — a sale without it must be rejected,
    // and obviously no confirmation email is attempted.
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const svc = await seedService(organizationId)
    const slot = await seedSlot(organizationId, svc.id)

    const res = await confirmSale(AGENT_EMAIL, {
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: 150000 }]
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('VALIDATION_ERROR')
    expect(resendCalls).toHaveLength(0)
  })

  it('Scenario 2b — Sale with malformed customer_email is rejected (400)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const svc = await seedService(organizationId)
    const slot = await seedSlot(organizationId, svc.id)

    const res = await confirmSale(AGENT_EMAIL, {
      customer_email: 'not-an-email',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: 150000 }]
    })
    expect(res.status).toBe(400)
    expect(resendCalls).toHaveLength(0)
  })

  it('Scenario 3 — Sale returns 201 even when Resend throws', async () => {
    mockFetchOk = false
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const svc = await seedService(organizationId)
    const slot = await seedSlot(organizationId, svc.id)

    const res = await confirmSale(AGENT_EMAIL, {
      customer_email: 'juan@example.com',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: 150000 }]
    })
    expect(res.status).toBe(201)
  })

  it('Scenario 5 — No Resend call when RESEND_API_KEY is empty', async () => {
    env.RESEND_API_KEY = ''
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const svc = await seedService(organizationId)
    const slot = await seedSlot(organizationId, svc.id)

    const res = await confirmSale(AGENT_EMAIL, {
      customer_email: 'juan@example.com',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: 150000 }]
    })
    expect(res.status).toBe(201)
    expect(resendCalls).toHaveLength(0)
  })

  it('Scenario 11 — user-controlled fields are HTML-escaped (Business Rule 9)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const svc = await seedService(organizationId)
    const slot = await seedSlot(organizationId, svc.id)

    const res = await confirmSale(AGENT_EMAIL, {
      customer_email: 'juan@example.com',
      customer_name: '<b>Juan</b> & "Co"',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: 150000 }]
    })
    expect(res.status).toBe(201)
    expect(resendCalls).toHaveLength(1)
    const html = resendCalls[0].html
    // Raw markup must not survive; escaped entities must be present.
    expect(html).not.toContain('<b>Juan</b>')
    expect(html).toContain('&lt;b&gt;Juan&lt;/b&gt; &amp; &quot;Co&quot;')
  })
})

describe('US-C03 — Cancellation Email', () => {
  it('Scenario 6 & 9 — Cancellation email sent with reason', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
    const svc = await seedService(organizationId, 'Tour Cancelled')
    const slot = await seedSlot(organizationId, svc.id)

    const saleRes = await confirmSale(AGENT_EMAIL, {
      customer_email: 'juan@example.com',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: 150000 }]
    })
    const folioId = (await saleRes.json() as any).folio.id
    resendCalls = []

    const res = await cancelFolio(ADMIN_EMAIL, folioId, { reason: 'Cliente no se presentó' })
    expect(res.status).toBe(200)
    
    expect(resendCalls).toHaveLength(1)
    const call = resendCalls[0]
    expect(call.to).toBe('juan@example.com')
    expect(call.subject).toContain('Empresa')
    expect(call.html).toContain('Tour Cancelled')
    expect(call.html).toContain('Motivo')
    expect(call.html).toContain('Cliente no se presentó')
  })

  it('Scenario 10 — Motivo section absent when reason is null', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
    const svc = await seedService(organizationId)
    const slot = await seedSlot(organizationId, svc.id)

    const saleRes = await confirmSale(AGENT_EMAIL, {
      customer_email: 'juan@example.com',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: 150000 }]
    })
    const folioId = (await saleRes.json() as any).folio.id
    resendCalls = []

    await cancelFolio(ADMIN_EMAIL, folioId, {})
    expect(resendCalls).toHaveLength(1)
    expect(resendCalls[0].html).not.toContain('Motivo:')
  })

  it('Scenario 7 — No Resend call on cancel when customer_email absent (defensive)', async () => {
    // POS now guarantees an email on every folio, so an emailless folio only arises
    // from legacy/direct data. Simulate it by nulling the column, then cancel: the
    // cancelFolio guard must skip the send without error.
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
    const svc = await seedService(organizationId)
    const slot = await seedSlot(organizationId, svc.id)

    const saleRes = await confirmSale(AGENT_EMAIL, {
      customer_email: 'juan@example.com',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: 150000 }]
    })
    const folioId = (await saleRes.json() as any).folio.id
    await env.DB.prepare('UPDATE folios SET customer_email = NULL WHERE id = ?').bind(folioId).run()
    resendCalls = []

    const res = await cancelFolio(ADMIN_EMAIL, folioId, {})
    expect(res.status).toBe(200)
    expect(resendCalls).toHaveLength(0)
  })

  it('Scenario 8 — Cancel returns 200 even when Resend throws', async () => {
    const { organizationId } = await seedUser({ email: ADMIN_EMAIL, role: 'admin' })
    await seedUser({ email: AGENT_EMAIL, role: 'agent', organizationId })
    const svc = await seedService(organizationId)
    const slot = await seedSlot(organizationId, svc.id)

    const saleRes = await confirmSale(AGENT_EMAIL, {
      customer_email: 'juan@example.com',
      lines: [{ slot_id: slot.id, quantity: 1, unit_price: 150000 }]
    })
    const folioId = (await saleRes.json() as any).folio.id
    resendCalls = []
    mockFetchOk = false

    const res = await cancelFolio(ADMIN_EMAIL, folioId, {})
    expect(res.status).toBe(200)
  })
})
