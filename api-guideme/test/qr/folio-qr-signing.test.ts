import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'
import { deriveOrgKey, verifyTicket } from '../../src/utils/qr'

// Folio generation with signed QR code (HMAC) — US-AG08, US-C02.
// Spec: docs/qr/folio-qr-signing.spec.md (Scenarios 1–8 + B1/B3 = 10/11).
// Scenario 9 (pure crypto roundtrip) lives in test/qr/qr.unit.test.ts.
//
// Tokens are asserted with the production deriveOrgKey/verifyTicket, keyed by
// `env.QR_SECRET` so the test key always matches whatever the worker signed with.

const AGENT_EMAIL = 'agent@empresa.com'

const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({
  ...auth(email),
  'Content-Type': 'application/json',
})

// --- Local seeders (raw D1) ------------------------------------------------

const seedService = async (
  organizationId: string,
  opts: { basePrice?: number; minimumPrice?: number; name?: string } = {},
): Promise<string> => {
  const { basePrice = 150000, minimumPrice = 100000, name = 'Canyon Tour' } = opts
  const serviceId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, name, basePrice, minimumPrice, 12, ts, ts)
    .run()
  return serviceId
}

const seedSlot = async (
  organizationId: string,
  serviceId: string,
  opts: { date?: string; startTime?: string; capacity?: number } = {},
): Promise<string> => {
  const { date = '2026-06-15', startTime = '06:00', capacity = 12 } = opts
  const slotId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO slots
       (id, organization_id, service_id, schedule_id, date, start_time, capacity, booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 'active', ?, ?)`,
  )
    .bind(slotId, organizationId, serviceId, date, startTime, capacity, ts, ts)
    .run()
  return slotId
}

const seedExtra = async (
  organizationId: string,
  serviceId: string,
  price = 25000,
): Promise<string> => {
  const extraId = crypto.randomUUID()
  const ts = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO service_extras
       (id, organization_id, service_id, name, price, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Photo', ?, 'active', ?, ?)`,
  )
    .bind(extraId, organizationId, serviceId, price, ts, ts)
    .run()
  return extraId
}

const getStoredTokens = async (folioId: string) => {
  const { results } = await env.DB.prepare(
    `SELECT id, slot_id, qr_token FROM folio_lines WHERE folio_id = ? ORDER BY created_at`,
  )
    .bind(folioId)
    .all<{ id: string; slot_id: string; qr_token: string | null }>()
  return results
}

// folio_line_extras → folio_lines → folios → slots → schedules → service_extras → services
const clearPosDb = async () => {
  await env.DB.exec('DELETE FROM folio_line_extras')
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM folios')
  await env.DB.exec('DELETE FROM slots')
  await env.DB.exec('DELETE FROM schedules')
  await env.DB.exec('DELETE FROM service_extras')
  await env.DB.exec('DELETE FROM services')
}

beforeEach(async () => {
  await clearPosDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

const base = 'http://api.local/api/pos'
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

const confirm = async (email: string, body: Record<string, unknown>) => {
  // customer_email is mandatory at POS; default it. Explicit bodies override.
  const res = await SELF.fetch(`${base}/folios`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify({ customer_email: 'cliente@example.com', ...body }),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const read = async (email: string, id: string) => {
  const res = await SELF.fetch(`${base}/folios/${id}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

// Expected expiry per spec: slot_date @ 00:00 UTC + 48h.
const expectedExpiry = (slotDate: string) =>
  Math.floor(Date.parse(`${slotDate}T00:00:00Z`) / 1000) + 48 * 3600

// ---------------------------------------------------------------------------
// US-AG08 / US-C02 — ticket generation
// ---------------------------------------------------------------------------
describe('Folio QR signing', () => {
  it('Scenario 1 — confirm stamps a QR token on every line; stored == returned', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)

    const { status, json } = await confirm(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })

    expect(status).toBe(201)
    const line = json.folio.lines[0]
    expect(line.qr_token).toMatch(TOKEN_RE)

    const stored = await getStoredTokens(json.folio.id)
    expect(stored).toHaveLength(1)
    expect(stored[0].qr_token).toBe(line.qr_token)
  })

  it('Scenario 2 — token payload roundtrips and verifies under the org key', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { date: '2026-06-15' })

    const { json } = await confirm(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 2, unit_price: 150000 }],
    })
    const line = json.folio.lines[0]

    const key = await deriveOrgKey(env.QR_SECRET, organizationId)
    const payload = await verifyTicket(line.qr_token, key)

    expect(payload).not.toBeNull()
    expect(payload).toMatchObject({
      v: 1,
      folio_id: json.folio.id,
      folio_line_id: line.id,
      organization_id: organizationId,
      service_id: serviceId,
      slot_id: slotId,
      passes_total: 2,
      expires_at: expectedExpiry('2026-06-15'),
    })
    // The signature-free echo mirrors the decoded payload.
    expect(line.qr).toMatchObject({
      folio_line_id: line.id,
      slot_id: slotId,
      passes_total: 2,
      expires_at: expectedExpiry('2026-06-15'),
    })
  })

  it('Scenario 3 — a tampered token does not verify', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)

    const { json } = await confirm(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    const token: string = json.folio.lines[0].qr_token
    // Flip one char inside the payload segment (index 5) → signature no longer matches.
    const repl = token[5] === 'A' ? 'B' : 'A'
    const tampered = token.slice(0, 5) + repl + token.slice(6)

    const key = await deriveOrgKey(env.QR_SECRET, organizationId)
    expect(tampered).not.toBe(token)
    expect(await verifyTicket(tampered, key)).toBeNull()
  })

  it('Scenario 4 — a token does not verify under another org-derived key', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)

    const { json } = await confirm(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    const token: string = json.folio.lines[0].qr_token

    const ownKey = await deriveOrgKey(env.QR_SECRET, organizationId)
    const foreignKey = await deriveOrgKey(env.QR_SECRET, crypto.randomUUID())
    expect(await verifyTicket(token, ownKey)).not.toBeNull()
    expect(await verifyTicket(token, foreignKey)).toBeNull()
  })

  it('Scenario 5 — client_identity falls back name → email', async () => {
    // customer_email is now mandatory at POS, so the final `folio:<id>` fallback in the
    // signing code is defensive-only (unreachable from a POS sale: email is always present,
    // and the identity is baked into the token at confirm time). Cover the two reachable
    // identities here: full name wins; email is used when no name is given.
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { capacity: 12 })
    const key = await deriveOrgKey(env.QR_SECRET, organizationId)

    const named = await confirm(AGENT_EMAIL, {
      customer_name: 'Jane Tourist',
      customer_email: 'jane@example.com',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    const emailOnly = await confirm(AGENT_EMAIL, {
      customer_email: 'jane@example.com',
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })

    const idOf = async (r: any) =>
      (await verifyTicket(r.json.folio.lines[0].qr_token, key))?.client_identity

    expect(await idOf(named)).toBe('Jane Tourist')
    expect(await idOf(emailOnly)).toBe('jane@example.com')
  })

  it('Scenario 6 — multi-line folio yields one distinct, verifying token per line', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slot1 = await seedSlot(organizationId, serviceId, { date: '2026-06-15', startTime: '06:00' })
    const slot2 = await seedSlot(organizationId, serviceId, { date: '2026-06-16', startTime: '09:00' })

    const { status, json } = await confirm(AGENT_EMAIL, {
      lines: [
        { slot_id: slot1, quantity: 1, unit_price: 150000 },
        { slot_id: slot2, quantity: 1, unit_price: 150000 },
      ],
    })
    expect(status).toBe(201)
    const tokens: string[] = json.folio.lines.map((l: any) => l.qr_token)
    expect(new Set(tokens).size).toBe(2)

    const key = await deriveOrgKey(env.QR_SECRET, organizationId)
    const slotIds = await Promise.all(
      tokens.map(async (t) => (await verifyTicket(t, key))?.slot_id),
    )
    expect(slotIds.sort()).toEqual([slot1, slot2].sort())
  })

  it('Scenario 7 — passes_total equals the line quantity', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId, { capacity: 10 })

    const { json } = await confirm(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 5, unit_price: 150000 }],
    })
    const key = await deriveOrgKey(env.QR_SECRET, organizationId)
    const payload = await verifyTicket(json.folio.lines[0].qr_token, key)
    expect(payload?.passes_total).toBe(5)
  })

  it('Scenario 8 — token is stored once, identical across confirm and reads', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)

    const { json } = await confirm(AGENT_EMAIL, {
      lines: [{ slot_id: slotId, quantity: 1, unit_price: 150000 }],
    })
    const original: string = json.folio.lines[0].qr_token

    const r1 = await read(AGENT_EMAIL, json.folio.id)
    const r2 = await read(AGENT_EMAIL, json.folio.id)
    expect(r1.json.folio.lines[0].qr_token).toBe(original)
    expect(r2.json.folio.lines[0].qr_token).toBe(original)
  })

  it('extras do not affect ticket signing (sanity: line still gets a valid token)', async () => {
    const { organizationId } = await seedUser({ email: AGENT_EMAIL, role: 'agent' })
    const serviceId = await seedService(organizationId)
    const slotId = await seedSlot(organizationId, serviceId)
    const extraId = await seedExtra(organizationId, serviceId)

    const { status, json } = await confirm(AGENT_EMAIL, {
      lines: [
        {
          slot_id: slotId,
          quantity: 1,
          unit_price: 150000,
          extras: [{ extra_id: extraId, quantity: 1 }],
        },
      ],
    })
    expect(status).toBe(201)
    const key = await deriveOrgKey(env.QR_SECRET, organizationId)
    expect(await verifyTicket(json.folio.lines[0].qr_token, key)).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // Multitenancy isolation (seedTwoOrgs) — B3, B1
  // -------------------------------------------------------------------------

  it('Scenario 10 — B3: foreign folio read → 404, no token leak', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    const agentB = 'agent-b@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })
    await seedUser({ email: agentB, role: 'agent', organizationId: orgB.organizationId })

    const serviceB = await seedService(orgB.organizationId)
    const slotB = await seedSlot(orgB.organizationId, serviceB)
    const { status, json } = await confirm(agentB, {
      lines: [{ slot_id: slotB, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)

    const foreign = await read(agentA, json.folio.id)
    expect(foreign.status).toBe(404)
    expect(foreign.json.error.code).toBe('NOT_FOUND')
    expect(JSON.stringify(foreign.json)).not.toContain(json.folio.lines[0].qr_token)
  })

  it('Scenario 11 — B1: injected organizationId ignored; payload org is the caller', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const agentA = 'agent-a@empresa.com'
    await seedUser({ email: agentA, role: 'agent', organizationId: orgA.organizationId })

    const serviceA = await seedService(orgA.organizationId)
    const slotA = await seedSlot(orgA.organizationId, serviceA)

    const { status, json } = await confirm(agentA, {
      organizationId: orgB.organizationId, // injected — must be ignored
      lines: [{ slot_id: slotA, quantity: 1, unit_price: 150000 }],
    })
    expect(status).toBe(201)

    const token: string = json.folio.lines[0].qr_token
    const callerKey = await deriveOrgKey(env.QR_SECRET, orgA.organizationId)
    const injectedKey = await deriveOrgKey(env.QR_SECRET, orgB.organizationId)

    const payload = await verifyTicket(token, callerKey)
    expect(payload?.organization_id).toBe(orgA.organizationId)
    // Signed under the caller's org key only — the injected org cannot verify it.
    expect(await verifyTicket(token, injectedKey)).toBeNull()
  })
})
