// devolada-transfer-verification US1 — a connected organization's full sale by transfer gets a
// payment link at checkout; when none can be created the sale stays on today's manual path, and an
// unconnected organization sees no change (FR-007–FR-010; research D6, D7, D14, D17).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { installFakeDevolada, type FakeDevolada } from '../helpers/devolada'
import {
  call,
  clearDevoladaDb,
  connectToFake,
  connectionRow,
  counts,
  folioRow,
  linkRows,
  paymentRowsOf,
  seedService,
  seedSellers,
  seedSlot,
  sellByTransfer,
  type SeededSellers,
} from '../helpers/devoladaFixtures'

const ORIGINAL_KEY = env.DEVOLADA_CREDENTIAL_KEY
const NOW = Math.floor(Date.parse('2026-06-14T12:00:00Z') / 1000)

let fake: FakeDevolada
let org: SeededSellers

beforeEach(async () => {
  await clearDevoladaDb()
  fake = await installFakeDevolada()
  org = await seedSellers('checkout')
})
afterEach(() => {
  vi.restoreAllMocks()
  env.DEVOLADA_CREDENTIAL_KEY = ORIGINAL_KEY
})

const adminRow = async (folioId: string) => {
  const res = await call(org.adminEmail, 'GET', '/folios')
  return res.json.folios.find((f: any) => f.id === folioId)
}

describe('a connected organization sells by transfer (D6, D7)', () => {
  it('the sale gets an open payment link; the seller sends no reference', async () => {
    await connectToFake(fake, org.adminEmail)
    const res = await sellByTransfer(org.agentEmail, org.slotId)
    expect(res.status, res.text).toBe(201)
    const { folio, payment_link: link } = res.json
    expect(folio.status).toBe('paid')
    expect(folio.payment_verification).toBe('pending')
    expect(folio.lines[0].qr_token).toBeNull()
    expect(res.json.payment_link_error).toBeUndefined()

    const [row] = await linkRows(folio.id)
    expect(link).toMatchObject({
      id: row.id,
      kind: 'sale',
      folio_line_id: null,
      state: 'open',
      amount: 150000,
      label: 'awaiting_payment',
      payment: null,
    })
    expect(link.url).toMatch(/^https:\/\/link\.devolada\.test\/p\//)
    // The earliest of 24 h and the first service start (three days out).
    expect(link.expires_at).toBe(NOW + 24 * 3600)
    expect(row.folio_payment_id).toBe((await paymentRowsOf(folio.id))[0].id)

    const [create] = fake.callsTo('createPaymentLink').slice(-1)
    expect(create!.body).toMatchObject({
      customerRef: folio.id,
      askCents: 150000,
      mode: 'one_time',
      expiresAt: link.expires_at * 1000,
      label: 'Cliente Test',
    })
    expect(create!.idempotencyKey).toBe(row.id)

    const events = (
      await env.DB.prepare(`SELECT * FROM folio_events WHERE folio_id = ? AND event_type = 'payment_link_issued'`)
        .bind(folio.id)
        .all<any>()
    ).results
    expect(events).toHaveLength(1)
    expect(events[0].actor_id).toBe(org.agentId)
    expect(JSON.parse(events[0].payload)).toEqual({
      link_id: row.id,
      kind: 'sale',
      amount: 150000,
      expires_at: link.expires_at,
    })
  })

  it('a link bounded by an earlier first service ends at its start', async () => {
    await connectToFake(fake, org.adminEmail)
    const soon = await seedSlot(org.organizationId, org.serviceId, { daysAhead: 0, startTime: '18:00' })
    const res = await sellByTransfer(org.agentEmail, soon)
    expect(res.json.payment_link.expires_at).toBe(Math.floor(Date.parse('2026-06-14T18:00:00Z') / 1000))
  })

  it('a reference that is sent is not stored', async () => {
    await connectToFake(fake, org.adminEmail)
    const res = await sellByTransfer(org.agentEmail, org.slotId, { payment_reference: 'BBVA-1234' })
    expect(res.status).toBe(201)
    expect(res.json.folio.payment_reference).toBeNull()
    expect((await folioRow(res.json.folio.id)).payment_reference).toBeNull()
    expect((await paymentRowsOf(res.json.folio.id))[0].reference).toBeNull()
  })

  it('right after checkout the sale is verification_auto, and counted so (D14)', async () => {
    await connectToFake(fake, org.adminEmail)
    const res = await sellByTransfer(org.agentEmail, org.slotId)
    const row = await adminRow(res.json.folio.id)
    expect(row.verification_auto).toBe(true)
    expect(row.payment_link).toMatchObject({ kind: 'sale', state: 'open', label: 'awaiting_payment' })
    expect(await counts(org.adminEmail)).toMatchObject({ verification: 1, verification_auto: 1 })
    const detail = await call(org.agentEmail, 'GET', `/pos/folios/${res.json.folio.id}`)
    expect(detail.json.folio.verification_auto).toBe(true)
    expect(detail.json.folio.payment_links).toHaveLength(1)
  })

  it('an idempotent replay returns the sale with its payment links', async () => {
    await connectToFake(fake, org.adminEmail)
    const first = await sellByTransfer(org.agentEmail, org.slotId, { idempotency_key: 'tap-0001-checkout' })
    const replay = await sellByTransfer(org.agentEmail, org.slotId, { idempotency_key: 'tap-0001-checkout' })
    expect(replay.status).toBe(200)
    expect(replay.json.replayed).toBe(true)
    expect(replay.json.folio.payment_links).toHaveLength(1)
    expect(replay.json.folio.payment_links[0].id).toBe(first.json.payment_link.id)
    expect(fake.callsTo('createPaymentLink')).toHaveLength(2) // the connect probe + the one link
  })

  it('a cash sale gets no link', async () => {
    await connectToFake(fake, org.adminEmail)
    const res = await call(org.agentEmail, 'POST', '/pos/folios', {
      customer_name: 'Cliente Test',
      customer_phone: '+52 55 1234 5678',
      payment_method: 'cash',
      lines: [{ slot_id: org.slotId, quantity: 1, unit_price: 150000 }],
    })
    expect(res.status).toBe(201)
    expect(res.json).not.toHaveProperty('payment_link')
    expect(await linkRows(res.json.folio.id)).toHaveLength(0)
  })
})

describe('no link can be created: the sale stays on the manual path (FR-010)', () => {
  const expectManualPath = async (res: Awaited<ReturnType<typeof sellByTransfer>>, error: string) => {
    expect(res.status, res.text).toBe(201)
    expect(res.json.payment_link).toBeNull()
    expect(res.json.payment_link_error).toBe(error)
    expect(res.json.folio.payment_verification).toBe('pending')
    const row = await adminRow(res.json.folio.id)
    expect(row.payment_link.label).toBe('link_failed')
    expect(row.verification_auto).toBe(false)
    expect((await counts(org.adminEmail)).verification_auto).toBe(0)
  }

  it('a create that times out leaves the link abandoned', async () => {
    await connectToFake(fake, org.adminEmail)
    fake.failNext('createPaymentLink', 'timeout')
    const res = await sellByTransfer(org.agentEmail, org.slotId)
    await expectManualPath(res, 'DEVOLADA_UNAVAILABLE')
    expect((await linkRows(res.json.folio.id))[0].state).toBe('abandoned')
  })

  it('a suspended business leaves the link failed and breaks the connection', async () => {
    const business = await connectToFake(fake, org.adminEmail)
    fake.suspend(business.businessId)
    const res = await sellByTransfer(org.agentEmail, org.slotId)
    await expectManualPath(res, 'DEVOLADA_BUSINESS_SUSPENDED')
    expect((await linkRows(res.json.folio.id))[0].state).toBe('failed')
    expect(await connectionRow(org.organizationId)).toMatchObject({
      status: 'broken',
      broken_reason: 'DEVOLADA_BUSINESS_SUSPENDED',
    })
  })

  it('a connection already broken writes a failed link without calling Devolada, and keeps the reference rule', async () => {
    await connectToFake(fake, org.adminEmail)
    await env.DB.prepare(
      `UPDATE devolada_connections SET status = 'broken', broken_reason = 'DEVOLADA_CREDENTIAL_REJECTED' WHERE organization_id = ?`,
    )
      .bind(org.organizationId)
      .run()
    const callsBefore = fake.calls.length

    const unreferenced = await sellByTransfer(org.agentEmail, org.slotId)
    expect(unreferenced.status).toBe(400)

    const res = await sellByTransfer(org.agentEmail, org.slotId, { payment_reference: 'BBVA-1234' })
    await expectManualPath(res, 'DEVOLADA_CREDENTIAL_REJECTED')
    expect(res.json.folio.payment_reference).toBe('BBVA-1234')
    expect((await linkRows(res.json.folio.id))[0]).toMatchObject({ state: 'failed', kind: 'sale' })
    expect(fake.calls.length).toBe(callsBefore)
  })

  it('a key this environment cannot read writes a failed link without calling Devolada (D17)', async () => {
    await connectToFake(fake, org.adminEmail)
    env.DEVOLADA_CREDENTIAL_KEY = btoa('another_devolada_credential_k_32')
    const callsBefore = fake.calls.length
    const res = await sellByTransfer(org.agentEmail, org.slotId)
    await expectManualPath(res, 'DEVOLADA_UNAVAILABLE')
    expect((await linkRows(res.json.folio.id))[0].state).toBe('failed')
    expect(fake.calls.length).toBe(callsBefore)
  })

  it('too little time before the service: no call, a failed link, PAYMENT_LINK_TOO_SHORT (D7)', async () => {
    await connectToFake(fake, org.adminEmail)
    const callsBefore = fake.calls.length
    // Starts in 10 minutes.
    const tenMinutes = await seedSlot(org.organizationId, org.serviceId, { daysAhead: 0, startTime: '12:10' })
    const soon = await sellByTransfer(org.agentEmail, tenMinutes)
    await expectManualPath(soon, 'PAYMENT_LINK_TOO_SHORT')
    expect((await linkRows(soon.json.folio.id))[0].state).toBe('failed')
    expect(fake.calls.length).toBe(callsBefore)
  })

  it('a service already started, sold inside the sales grace, is too short too (D7)', async () => {
    await connectToFake(fake, org.adminEmail)
    await env.DB.prepare(`UPDATE organizations SET sales_cutoff_offset_minutes = -60 WHERE id = ?`)
      .bind(org.organizationId)
      .run()
    const started = await seedSlot(org.organizationId, org.serviceId, { daysAhead: 0, startTime: '11:30' })
    const res = await sellByTransfer(org.agentEmail, started)
    await expectManualPath(res, 'PAYMENT_LINK_TOO_SHORT')
  })
})

describe('an organization that never connected (US1 scenario 5)', () => {
  it('sees no change: no link keys, and the reference rule as today', async () => {
    const without = await sellByTransfer(org.agentEmail, org.slotId)
    expect(without.status).toBe(400)
    const res = await sellByTransfer(org.agentEmail, org.slotId, { payment_reference: 'BBVA-1234' })
    expect(res.status).toBe(201)
    expect(res.json).not.toHaveProperty('payment_link')
    expect(res.json).not.toHaveProperty('payment_link_error')
    expect(res.json.folio.payment_reference).toBe('BBVA-1234')
    expect(fake.calls).toHaveLength(0)
    const row = await adminRow(res.json.folio.id)
    expect(row.payment_link).toBeNull()
    expect(row.verification_auto).toBe(false)
  })

  it('a second organization of the same suite is not affected by another being connected', async () => {
    await connectToFake(fake, org.adminEmail)
    const other = await seedSellers('checkout-other')
    const service = await seedService(other.organizationId)
    const slot = await seedSlot(other.organizationId, service)
    const res = await sellByTransfer(other.agentEmail, slot, { payment_reference: 'BBVA-1234' })
    expect(res.status).toBe(201)
    expect(res.json).not.toHaveProperty('payment_link')
  })
})
