// devolada-transfer-verification US1 — an admin connects the organization's own Devolada account,
// sees its health, replaces the key or disconnects; nobody else reads or changes it (FR-001–FR-006,
// research D1–D3, D17, D21; contracts/turistear-api.md § Connection).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { seedTwoOrgs } from '../helpers/tenancy'
import { installFakeDevolada, WEBHOOK_URL_OF_THIS_API, type FakeDevolada } from '../helpers/devolada'
import {
  call,
  clearDevoladaDb,
  connectionRow,
  credentialRows,
  insertLink,
  insertPayment,
  seedSellers,
  sellByTransfer,
  type SeededSellers,
} from '../helpers/devoladaFixtures'

const ME = '/organizations/me/devolada'
const ORIGINAL_ENV = {
  DEVOLADA_WEBHOOK_URL: env.DEVOLADA_WEBHOOK_URL,
  DEVOLADA_CREDENTIAL_KEY: env.DEVOLADA_CREDENTIAL_KEY,
}

let fake: FakeDevolada
let org: SeededSellers

beforeEach(async () => {
  await clearDevoladaDb()
  fake = await installFakeDevolada()
  org = await seedSellers('conn')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.setSystemTime(new Date('2026-06-14T12:00:00Z'))
  env.DEVOLADA_WEBHOOK_URL = ORIGINAL_ENV.DEVOLADA_WEBHOOK_URL
  env.DEVOLADA_CREDENTIAL_KEY = ORIGINAL_ENV.DEVOLADA_CREDENTIAL_KEY
})

const connect = (apiKey: string, extra: Record<string, unknown> = {}) =>
  call(org.adminEmail, 'PUT', ME, { api_key: apiKey, ...extra })

describe('connect (D2, D3)', () => {
  it('a valid test key connects: probe link born expired, our address registered', async () => {
    const business = fake.addBusiness()
    const res = await connect(business.apiKey)
    expect(res.status, res.text).toBe(200)
    expect(res.json.connection).toMatchObject({
      status: 'connected',
      mode: 'test',
      key_hint: business.apiKey.slice(-4),
      broken_reason: null,
      previous_keys: [],
      connected_by: { id: org.adminId, name: 'Ana Ruiz' },
      health_error: null,
    })
    expect(res.json.connection.webhook).toMatchObject({ url: WEBHOOK_URL_OF_THIS_API, is_ours: true })

    const [probe] = fake.callsTo('createPaymentLink')
    expect(probe!.body).toMatchObject({ customerRef: 'turistear-conexion', askCents: 100, mode: 'one_time' })
    expect((probe!.body as any).expiresAt).toBeLessThan(Date.now())
    expect(probe!.idempotencyKey).toBeTruthy()
    expect(fake.businesses.get(business.businessId)!.webhook?.url).toBe(WEBHOOK_URL_OF_THIS_API)
    expect(fake.callsTo('putWebhook')).toHaveLength(1)
  })

  it('refuses a key of the wrong format with 400, without calling Devolada', async () => {
    const res = await connect('dk_short')
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('VALIDATION_ERROR')
    expect(fake.calls).toHaveLength(0)
  })

  it('refuses a key Devolada rejects with 422 DEVOLADA_CREDENTIAL_REJECTED', async () => {
    const business = fake.addBusiness()
    fake.revokeKey(business.apiKey)
    const res = await connect(business.apiKey)
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe('DEVOLADA_CREDENTIAL_REJECTED')
    expect(await connectionRow(org.organizationId)).toBeNull()
  })

  it('refuses a real key in a test environment with 422 DEVOLADA_MODE_NOT_ALLOWED', async () => {
    const business = fake.addBusiness({ mode: 'real' })
    const res = await connect(business.apiKey)
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe('DEVOLADA_MODE_NOT_ALLOWED')
    expect(await credentialRows(org.organizationId)).toHaveLength(0)
  })

  it('refuses a business without its CLABE with 409 DEVOLADA_CHANNEL_UNAVAILABLE, message clabe', async () => {
    const business = fake.addBusiness({ channel: 'clabe' })
    const res = await connect(business.apiKey)
    expect(res.status).toBe(409)
    expect(res.json.error).toEqual({ code: 'DEVOLADA_CHANNEL_UNAVAILABLE', message: 'clabe' })
  })

  it('refuses a suspended business with 409 DEVOLADA_BUSINESS_SUSPENDED', async () => {
    const business = fake.addBusiness({ suspended: true })
    const res = await connect(business.apiKey)
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('DEVOLADA_BUSINESS_SUSPENDED')
  })

  it('answers 502 DEVOLADA_UNAVAILABLE while Devolada is down', async () => {
    const business = fake.addBusiness()
    fake.down('unreachable')
    const res = await connect(business.apiKey)
    expect(res.status).toBe(502)
    expect(res.json.error.code).toBe('DEVOLADA_UNAVAILABLE')
    fake.up()
    fake.failNext('createPaymentLink', 'timeout')
    expect((await connect(business.apiKey)).status).toBe(502)
    expect(await connectionRow(org.organizationId)).toBeNull()
  })
})

describe('the notification address (D3, FR-006)', () => {
  it('another address is a 409 naming it; replace_webhook takes it and records the replaced one', async () => {
    const business = fake.addBusiness({ webhookUrl: 'https://otro.example/hooks/devolada' })
    const refused = await connect(business.apiKey)
    expect(refused.status).toBe(409)
    expect(refused.json.error).toEqual({
      code: 'DEVOLADA_WEBHOOK_CONFLICT',
      message: 'https://otro.example/hooks/devolada',
    })
    expect(fake.callsTo('putWebhook')).toHaveLength(0)

    const replaced = await connect(business.apiKey, { replace_webhook: true })
    expect(replaced.status, replaced.text).toBe(200)
    expect(fake.businesses.get(business.businessId)!.webhook?.url).toBe(WEBHOOK_URL_OF_THIS_API)
    expect((await connectionRow(org.organizationId)).replaced_webhook_url).toBe(
      'https://otro.example/hooks/devolada',
    )
  })

  it('our own address already registered is kept, not written again', async () => {
    const business = fake.addBusiness({ webhookUrl: WEBHOOK_URL_OF_THIS_API })
    expect((await connect(business.apiKey)).status).toBe(200)
    expect(fake.callsTo('putWebhook')).toHaveLength(0)
  })

  it('where this environment registers none (local, previews), the address is neither read nor written', async () => {
    env.DEVOLADA_WEBHOOK_URL = ''
    const business = fake.addBusiness({ webhookUrl: 'https://api-dev.example/api/webhooks/devolada' })
    const res = await connect(business.apiKey)
    expect(res.status, res.text).toBe(200)
    expect(fake.calls.filter((c) => c.route === 'putWebhook')).toHaveLength(0)
    // The connect itself read nothing; only the view's health read the address afterwards.
    const connectCalls = fake.calls.slice(0, fake.calls.findIndex((c) => c.route === 'getWebhook'))
    expect(connectCalls.map((c) => c.route)).toEqual(['createPaymentLink'])
    expect(res.json.connection.webhook.is_ours).toBeNull()
    expect(fake.businesses.get(business.businessId)!.webhook?.url).toBe(
      'https://api-dev.example/api/webhooks/devolada',
    )
    expect((await connectionRow(org.organizationId)).webhook_url).toBeNull()
  })
})

describe('health (FR-005, D2)', () => {
  it('reads the address and its failing deliveries live', async () => {
    const business = fake.addBusiness()
    await connect(business.apiKey)
    fake.setWebhookHealth(business.businessId, { consecutiveFailures: 3, lastFailureAt: Date.now() })
    fake.setFailedDeliveries(business.businessId, 2)
    const res = await call(org.adminEmail, 'GET', ME)
    expect(res.status).toBe(200)
    expect(res.json.connection.webhook).toMatchObject({
      is_ours: true,
      consecutive_failures: 3,
      last_failure_at: Math.floor(Date.now() / 1000),
      failed_deliveries: 2,
    })
    expect(res.json.connection.health_error).toBeNull()
  })

  it('Devolada down never fails the read: health_error says so', async () => {
    const business = fake.addBusiness()
    await connect(business.apiKey)
    fake.down('500')
    const res = await call(org.adminEmail, 'GET', ME)
    expect(res.status).toBe(200)
    expect(res.json.connection).toMatchObject({
      status: 'connected',
      webhook: null,
      health_error: 'DEVOLADA_UNAVAILABLE',
    })
  })

  it('a broken connection whose probe passes again reads connected; one still failing stays broken and is not probed again within 15 minutes', async () => {
    const business = fake.addBusiness()
    await connect(business.apiKey)
    await env.DB.prepare(
      `UPDATE devolada_connections SET status = 'broken', broken_reason = 'DEVOLADA_BUSINESS_SUSPENDED', broken_at = ? WHERE organization_id = ?`,
    )
      .bind(Math.floor(Date.now() / 1000), org.organizationId)
      .run()
    fake.suspend(business.businessId)

    const probesBefore = fake.callsTo('createPaymentLink').length
    const still = await call(org.adminEmail, 'GET', ME)
    expect(still.json.connection).toMatchObject({ status: 'broken', broken_reason: 'DEVOLADA_BUSINESS_SUSPENDED' })
    expect(fake.callsTo('createPaymentLink').length).toBe(probesBefore + 1)

    // Within 15 minutes another read does not probe again, even though the suspension lifted.
    fake.suspend(business.businessId, false)
    vi.setSystemTime(new Date('2026-06-14T12:10:00Z'))
    expect((await call(org.adminEmail, 'GET', ME)).json.connection.status).toBe('broken')
    expect(fake.callsTo('createPaymentLink').length).toBe(probesBefore + 1)

    vi.setSystemTime(new Date('2026-06-14T12:16:00Z'))
    const healed = await call(org.adminEmail, 'GET', ME)
    expect(healed.json.connection).toMatchObject({ status: 'connected', broken_reason: null })
    expect(fake.callsTo('createPaymentLink').length).toBe(probesBefore + 2)
  })
})

describe('disconnect (FR-004, D21)', () => {
  it('sets disconnected, retires the current key, reads nothing from Devolada, and is idempotent', async () => {
    const business = fake.addBusiness()
    await connect(business.apiKey)
    const callsBefore = fake.calls.length

    const res = await call(org.adminEmail, 'DELETE', ME)
    expect(res.status).toBe(200)
    expect(res.json.connection).toMatchObject({
      status: 'disconnected',
      mode: null,
      key_hint: null,
      webhook: null,
      health_error: null,
    })
    expect(fake.calls.length).toBe(callsBefore)
    const [credential] = await credentialRows(org.organizationId)
    expect(credential.retired_at).not.toBeNull()
    expect((await connectionRow(org.organizationId)).current_credential_id).toBeNull()
    // Devolada's address is left as it is (D3).
    expect(fake.businesses.get(business.businessId)!.webhook?.url).toBe(WEBHOOK_URL_OF_THIS_API)

    const again = await call(org.adminEmail, 'DELETE', ME)
    expect(again.status).toBe(200)
    expect(again.json.connection.status).toBe('disconnected')
    expect((await call(org.adminEmail, 'GET', ME)).json.connection.status).toBe('disconnected')
  })

  it('an organization that never connected disconnects to nothing', async () => {
    const res = await call(org.adminEmail, 'DELETE', ME)
    expect(res.status).toBe(200)
    expect(res.json.connection).toBeNull()
  })
})

describe('replacing the key (D21)', () => {
  // Sales made before connecting, so no enlace is issued for them: the test places its own.
  const sellUnconnected = async () =>
    (await sellByTransfer(org.agentEmail, org.slotId, { payment_reference: 'REF-1234' })).json.folio.id as string
  const placeLink = (folioId: string, credentialId: string, state = 'open') =>
    insertLink({
      organizationId: org.organizationId,
      folioId,
      credentialId,
      requestedBy: org.agentId,
      state,
      devoladaLinkId: `lnk_${crypto.randomUUID()}`,
    })

  it('another key, of the same business or another, becomes current; the previous one is listed while it has pending enlaces', async () => {
    const saleA = await sellUnconnected()
    const saleB = await sellUnconnected()
    const first = fake.addBusiness()
    await connect(first.apiKey)
    const [firstCredential] = await credentialRows(org.organizationId)

    // A rotation within the same business.
    const rotated = fake.addKey(first.businessId)
    const second = await connect(rotated)
    expect(second.status, second.text).toBe(200)
    expect(second.json.connection).toMatchObject({ key_hint: rotated.slice(-4), mode: 'test', previous_keys: [] })
    const afterRotation = await credentialRows(org.organizationId)
    expect(afterRotation).toHaveLength(2)
    expect(afterRotation[0].retired_at).not.toBeNull()
    expect(afterRotation[1].retired_at).toBeNull()

    // Two unresolved enlaces on the first key, one closed under a payment in flight.
    const open = await placeLink(saleA, firstCredential.id)
    const closed = await placeLink(saleB, firstCredential.id, 'closed')
    await insertPayment({ organizationId: org.organizationId, linkId: closed, folioId: saleB, status: 'validating' })

    // A switch to another business's key.
    const other = fake.addBusiness()
    const third = await connect(other.apiKey)
    expect(third.json.connection.key_hint).toBe(other.apiKey.slice(-4))
    expect(third.json.connection.previous_keys).toEqual([
      { key_hint: first.apiKey.slice(-4), pending_links: 2 },
    ])

    // Once they resolve, the list is empty; a disconnected organization's view keeps it meanwhile.
    await call(org.adminEmail, 'DELETE', ME)
    // The other business's key, retired by the disconnect, has no pending enlace: it is not listed.
    expect((await call(org.adminEmail, 'GET', ME)).json.connection.previous_keys).toEqual([
      { key_hint: first.apiKey.slice(-4), pending_links: 2 },
    ])
    await env.DB.prepare(`UPDATE devolada_links SET state = 'paid' WHERE id = ?`).bind(open).run()
    await env.DB.prepare(`UPDATE devolada_payments SET status = 'unapplied' WHERE link_id = ?`).bind(closed).run()
    const resolved = await call(org.adminEmail, 'GET', ME)
    expect(resolved.json.connection.previous_keys).toEqual([])
  })
})

describe('this environment cannot store keys (D17)', () => {
  it('without DEVOLADA_CREDENTIAL_KEY, connecting answers 500 and calls nothing', async () => {
    env.DEVOLADA_CREDENTIAL_KEY = ''
    const business = fake.addBusiness()
    const res = await connect(business.apiKey)
    expect(res.status).toBe(500)
    expect(res.json.error.code).toBe('INTERNAL_ERROR')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('secrecy (D1, FR-003)', () => {
  it('no response carries the key or its ciphertext; /organizations/me carries only status and mode', async () => {
    const business = fake.addBusiness()
    const connected = await connect(business.apiKey)
    const [credential] = await credentialRows(org.organizationId)
    const read = await call(org.adminEmail, 'GET', ME)
    for (const res of [connected, read]) {
      expect(res.text).not.toContain(business.apiKey)
      expect(res.text).not.toContain(credential.ciphertext)
    }
    for (const email of [org.adminEmail, org.agentEmail]) {
      const me = await call(email, 'GET', '/organizations/me')
      expect(me.status).toBe(200)
      expect(me.json.organization.devolada).toEqual({ status: 'connected', mode: 'test' })
      expect(me.text).not.toContain(business.apiKey)
      expect(me.text).not.toContain(business.apiKey.slice(-4))
    }
  })

  it('an organization that never connected reads not_connected', async () => {
    const me = await call(org.agentEmail, 'GET', '/organizations/me')
    expect(me.json.organization.devolada).toEqual({ status: 'not_connected', mode: null })
  })
})

describe('roles and isolation (constitution III)', () => {
  it('an agent gets 403 on all three routes', async () => {
    const business = fake.addBusiness()
    expect((await call(org.agentEmail, 'GET', ME)).status).toBe(403)
    expect((await call(org.agentEmail, 'PUT', ME, { api_key: business.apiKey })).status).toBe(403)
    expect((await call(org.agentEmail, 'DELETE', ME)).status).toBe(403)
    expect(fake.calls).toHaveLength(0)
  })

  it("org B's admin sees no connection and cannot change org A's", async () => {
    await clearDevoladaDb()
    const { orgA, orgB } = await seedTwoOrgs()
    const business = fake.addBusiness()
    const a = await call(orgA.adminEmail, 'PUT', ME, { api_key: business.apiKey })
    expect(a.status).toBe(200)

    expect((await call(orgB.adminEmail, 'GET', ME)).json.connection).toBeNull()
    await call(orgB.adminEmail, 'DELETE', ME)
    expect((await call(orgA.adminEmail, 'GET', ME)).json.connection.status).toBe('connected')
    expect(await connectionRow(orgB.organizationId)).toBeNull()
  })
})
