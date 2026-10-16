// devolada-transfer-verification US1 — a transfer sale clears itself when Banxico confirms the
// money: Devolada's signed notification is verified, routed by the link, re-read with the link's own
// credential, and applied (FR-012–FR-014, research D4, D9, D10, D14, D21).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { stubResend, type SentEmail } from '../helpers/auth-flows'
import { installFakeDevolada, WEBHOOK_REQUEST_URL, type FakeDevolada } from '../helpers/devolada'
import { readCappedBody } from '../../src/routes/webhooks'
import {
  call,
  clearDevoladaDb,
  connectToFake,
  connectionRow,
  counts,
  folioRow,
  linkRows,
  paymentRowsOf,
  sellByTransfer,
  seedSellers,
  type SeededSellers,
} from '../helpers/devoladaFixtures'

let fake: FakeDevolada
let org: SeededSellers
let emails: SentEmail[]

beforeEach(async () => {
  await clearDevoladaDb()
  emails = stubResend()
  fake = await installFakeDevolada()
  org = await seedSellers('hook')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.setSystemTime(new Date('2026-06-14T12:00:00Z'))
})

/** A connected organization's sale by transfer, with its open link. */
const sale = async () => {
  const business = await connectToFake(fake, org.adminEmail)
  const res = await sellByTransfer(org.agentEmail, org.slotId, { customer_email: 'cliente@example.com' })
  expect(res.status, res.text).toBe(201)
  const [link] = await linkRows(res.json.folio.id)
  return { business, folioId: res.json.folio.id as string, link }
}

const deliver = async (req: Request) => {
  const res = await SELF.fetch(req)
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

const adminRow = async (folioId: string) =>
  (await call(org.adminEmail, 'GET', '/folios')).json.folios.find((f: any) => f.id === folioId)

const eventRow = (eventId: string) =>
  env.DB.prepare(`SELECT * FROM devolada_events WHERE event_id = ?`).bind(eventId).first<any>()

describe('a delivery that is not trusted changes nothing (D4)', () => {
  it('a bad signature is 401', async () => {
    const { link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    expect((await deliver(await fake.signedEvent(paymentId, { tamperBody: true }))).status).toBe(401)
    expect((await deliver(await fake.signedEvent(paymentId, { wrongKey: true }))).status).toBe(401)
    expect((await deliver(await fake.signedEvent(paymentId, { keyId: 'not-published' }))).status).toBe(401)
    expect((await folioRow(link.folio_id)).payment_verification).toBe('pending')
    expect((await env.DB.prepare('SELECT count(*) AS n FROM devolada_events').first<any>()).n).toBe(0)
  })

  it('malformed JSON and an unknown shape are 400', async () => {
    await sale()
    const notJson = await deliver(await fake.signedRaw('{not json'))
    expect(notJson.status).toBe(400)
    expect(notJson.json.error.code).toBe('WEBHOOK_PAYLOAD_INVALID')
    expect((await deliver(await fake.signedRaw(JSON.stringify({ hello: 'world' })))).status).toBe(400)
  })

  it('a body over 64 KiB is 400 before its signature is checked', async () => {
    await sale()
    const big = JSON.stringify({ eventId: 'evt_big', padding: 'x'.repeat(70 * 1024) })
    const res = await deliver(await fake.signedRaw(big))
    expect(res.status).toBe(400)
    expect(fake.callsTo('jwks')).toHaveLength(0)
  })

  it('a body streamed without a length is read only up to 64 KiB', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024))
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Far more than the limit: the reader must stop on its own.
        if (pulled >= 64) return controller.close()
        pulled += 1
        controller.enqueue(chunk)
      },
    })
    const req = new Request(WEBHOOK_REQUEST_URL, { method: 'POST', body })
    expect(await readCappedBody(req, 64 * 1024)).toBeNull()
    expect(pulled).toBeLessThan(64)
    const small = new Request(WEBHOOK_REQUEST_URL, { method: 'POST', body: '{"ok":true}' })
    expect(await readCappedBody(small, 64 * 1024)).toBe('{"ok":true}')
  })

  it('an unknown link is 200 and writes nothing', async () => {
    const { link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    // A link of Devolada's that is not ours.
    fake.link(link.devolada_link_id).id = 'lnk_someone_else'
    fake.links.set('lnk_someone_else', fake.link(link.devolada_link_id))
    fake.payments.get(paymentId)!.linkId = 'lnk_someone_else'
    const res = await deliver(await fake.signedEvent(paymentId))
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ received: true })
    expect((await env.DB.prepare('SELECT count(*) AS n FROM devolada_events').first<any>()).n).toBe(0)
    expect((await env.DB.prepare('SELECT count(*) AS n FROM devolada_payments').first<any>()).n).toBe(0)
  })

  it("an event whose mode is not the link's is 200 and recorded as mode_mismatch", async () => {
    const { link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    const res = await deliver(await fake.signedEvent(paymentId, { isTest: false, eventId: 'evt_mode' }))
    expect(res.status).toBe(200)
    expect((await eventRow('evt_mode')).outcome).toBe('mode_mismatch')
    expect((await folioRow(link.folio_id)).payment_verification).toBe('pending')
  })
})

describe('a confirmed verdict clears the sale (US1 scenarios 1-2, D9, D10)', () => {
  it('verifies the row as «Sistema», releases the tickets, and closes the link as paid', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    const confirmed = fake.advance(paymentId, 'confirmed')
    const res = await deliver(await fake.signedEvent(paymentId, { eventId: 'evt_ok' }))
    expect(res.status).toBe(200)

    const [row] = await paymentRowsOf(folioId)
    expect(row).toMatchObject({ verification: 'verified', verified_by: null, reference: confirmed.folio })
    expect(await folioRow(folioId)).toMatchObject({
      payment_verification: 'verified',
      payment_verified_by: null,
      payment_reference: confirmed.folio,
    })
    const detail = (await call(org.adminEmail, 'GET', `/folios/${folioId}`)).json
    expect(detail.folio.lines[0].qr_token).toBeTruthy()
    expect(detail.folio.portal_link).toBeTruthy()
    expect(detail.folio.payment_links[0]).toMatchObject({
      state: 'paid',
      label: 'confirmed',
      payment: { status: 'confirmed', receipt_number: confirmed.folio, received: 150000 },
    })
    const verified = detail.events.filter((e: any) => e.type === 'payment_verified')
    expect(verified).toHaveLength(1)
    expect(verified[0].actor).toBeNull()
    expect(verified[0].payload).toMatchObject({ source: 'devolada', receipt_number: confirmed.folio })

    const notifications = (
      await env.DB.prepare(`SELECT event FROM notifications WHERE folio_id = ? AND channel = 'whatsapp'`)
        .bind(folioId)
        .all<any>()
    ).results.map((n: any) => n.event)
    expect(notifications).toEqual(expect.arrayContaining(['payment_verified', 'tickets_delivered']))
    expect((await eventRow('evt_ok')).outcome).toBe('applied')
    expect((await connectionRow(org.organizationId)).last_verdict_at).not.toBeNull()
    await vi.waitFor(() => expect(emails.some((m) => m.to === 'cliente@example.com')).toBe(true))
  })
})

describe('the re-read decides (D4)', () => {
  it('a duplicate eventId is not applied twice', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    const req = () => fake.signedEvent(paymentId, { eventId: 'evt_dup' })
    expect((await deliver(await req())).status).toBe(200)
    const qr = (await call(org.adminEmail, 'GET', `/folios/${folioId}`)).json.folio.lines[0].qr_token
    const rereads = fake.callsTo('getPayment').length
    expect((await deliver(await req())).status).toBe(200)
    expect(fake.callsTo('getPayment').length).toBe(rereads)
    expect((await call(org.adminEmail, 'GET', `/folios/${folioId}`)).json.folio.lines[0].qr_token).toBe(qr)
    expect((await eventRow('evt_dup')).attempts).toBe(1)
  })

  it('a body that says confirmed while the re-read says validating yields only a snapshot', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    const res = await deliver(await fake.signedEvent(paymentId, { as: 'confirmed' }))
    expect(res.status).toBe(200)
    expect((await folioRow(folioId)).payment_verification).toBe('pending')
    expect((await adminRow(folioId)).payment_link.label).toBe('validating')
  })

  it('a re-read answering NOT_FOUND changes nothing', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    // The payment belongs to another business: the link's key cannot read it.
    fake.payments.get(paymentId)!.businessId = fake.addBusiness().businessId
    const res = await deliver(await fake.signedEvent(paymentId, { eventId: 'evt_nf' }))
    expect(res.status).toBe(200)
    expect((await folioRow(folioId)).payment_verification).toBe('pending')
    expect((await eventRow('evt_nf')).outcome).toBe('no_change')
    expect((await env.DB.prepare('SELECT count(*) AS n FROM devolada_payments').first<any>()).n).toBe(0)
  })

  it('an unreachable re-read is 503; a later retry applies the verdict', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    fake.failNext('getPayment', 'unreachable')
    const first = await deliver(await fake.signedEvent(paymentId, { eventId: 'evt_retry' }))
    expect(first.status).toBe(503)
    expect(first.json.error.code).toBe('DEVOLADA_UNAVAILABLE')
    expect((await eventRow('evt_retry')).outcome).toBe('failed')

    const retry = await deliver(await fake.signedEvent(paymentId, { eventId: 'evt_retry' }))
    expect(retry.status).toBe(200)
    expect((await folioRow(folioId)).payment_verification).toBe('verified')
    expect(await eventRow('evt_retry')).toMatchObject({ outcome: 'applied', attempts: 2 })
  })

  it("the keys being unreachable is 503, so Devolada retries", async () => {
    const { link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.failNext('jwks', 'unreachable')
    expect((await deliver(await fake.signedEvent(paymentId))).status).toBe(503)
  })
})

describe("each link is re-read with its own key (D21, FR-004)", () => {
  it('after a switch to another business, a link of the previous key is re-read with it and applied', async () => {
    const { business, folioId, link } = await sale()
    await connectToFake(fake, org.adminEmail) // another business becomes current
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    expect((await deliver(await fake.signedEvent(paymentId))).status).toBe(200)
    expect((await folioRow(folioId)).payment_verification).toBe('verified')
    expect(fake.callsTo('getPayment').slice(-1)[0]!.apiKey).toBe(business.apiKey)
  })

  it("a disconnected organization's link is applied the same way, its key kept", async () => {
    const { business, folioId, link } = await sale()
    await call(org.adminEmail, 'DELETE', '/organizations/me/devolada')
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    expect((await deliver(await fake.signedEvent(paymentId))).status).toBe(200)
    expect((await folioRow(folioId)).payment_verification).toBe('verified')
    expect(fake.callsTo('getPayment').slice(-1)[0]!.apiKey).toBe(business.apiKey)
  })

  it('a rejected current key on the re-read breaks the connection and answers 503', async () => {
    const { business, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.revokeKey(business.apiKey)
    expect((await deliver(await fake.signedEvent(paymentId))).status).toBe(503)
    expect(await connectionRow(org.organizationId)).toMatchObject({
      status: 'broken',
      broken_reason: 'DEVOLADA_CREDENTIAL_REJECTED',
    })
  })
})

describe('waiting statuses are snapshots, labelled by the server (D9, D14)', () => {
  it('validating, then queued_for_credit, then awaiting a tracking key', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    await deliver(await fake.signedEvent(paymentId))
    expect((await adminRow(folioId)).payment_link.label).toBe('validating')

    fake.advance(paymentId, 'queued_for_credit')
    await deliver(await fake.signedEvent(paymentId))
    expect((await adminRow(folioId)).payment_link.label).toBe('credit_paused')
    const view = (await call(org.adminEmail, 'GET', '/organizations/me/devolada')).json.connection
    expect(view.credit_paused_since).not.toBeNull()

    // A re-read straight to confirmed, with no validating in between, clears the pause.
    fake.advance(paymentId, 'confirmed')
    await deliver(await fake.signedEvent(paymentId))
    expect((await connectionRow(org.organizationId)).credit_paused_at).toBeNull()
    expect((await folioRow(folioId)).payment_verification).toBe('verified')
  })

  it('awaiting the payer tracking key reads needs_tracking_key', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.setAwaiting(paymentId, 'ambiguous')
    await deliver(await fake.signedEvent(paymentId))
    const row = await adminRow(folioId)
    expect(row.payment_link).toMatchObject({
      label: 'needs_tracking_key',
      payment: { awaiting: 'payer_tracking_key', awaiting_reason: 'ambiguous' },
    })
    const seller = await call(org.agentEmail, 'GET', `/pos/folios/${folioId}`)
    expect(seller.json.folio.payment_links[0].label).toBe('needs_tracking_key')
  })

  it("queued_for_credit on a retired key's link leaves the health alone (D21)", async () => {
    const { link } = await sale()
    await connectToFake(fake, org.adminEmail)
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'queued_for_credit')
    await deliver(await fake.signedEvent(paymentId))
    expect((await connectionRow(org.organizationId)).credit_paused_at).toBeNull()
  })
})

describe('verification_auto follows the payment (D14)', () => {
  const flag = async (folioId: string) => (await adminRow(folioId)).verification_auto
  const autoCount = async () => (await counts(org.adminEmail)).verification_auto

  it('true while awaiting the first payment and while validating, even past expires_at', async () => {
    const { folioId, link } = await sale()
    expect(await flag(folioId)).toBe(true)
    const paymentId = fake.submitProof(link.devolada_link_id)
    await deliver(await fake.signedEvent(paymentId))
    vi.setSystemTime(new Date((link.expires_at + 60) * 1000))
    expect(await flag(folioId)).toBe(true)
    expect(await autoCount()).toBe(1)
  })

  it('false once a link with no payment is past expires_at, before any sweep', async () => {
    const { folioId, link } = await sale()
    vi.setSystemTime(new Date((link.expires_at + 60) * 1000))
    expect(await flag(folioId)).toBe(false)
    expect(await autoCount()).toBe(0)
  })

  it('false with queued_for_credit and with a tracking-key wait', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'queued_for_credit')
    await deliver(await fake.signedEvent(paymentId))
    expect(await flag(folioId)).toBe(false)
    fake.advance(paymentId, 'validating')
    fake.setAwaiting(paymentId)
    await deliver(await fake.signedEvent(paymentId))
    expect(await flag(folioId)).toBe(false)
  })

  it('false while the connection is broken and the link uses its current key; true again once connected; a retired key keeps it', async () => {
    const { folioId } = await sale()
    await env.DB.prepare(`UPDATE devolada_connections SET status = 'broken', broken_reason = 'DEVOLADA_BUSINESS_SUSPENDED' WHERE organization_id = ?`)
      .bind(org.organizationId)
      .run()
    expect(await flag(folioId)).toBe(false)
    await env.DB.prepare(`UPDATE devolada_connections SET status = 'connected', broken_reason = NULL WHERE organization_id = ?`)
      .bind(org.organizationId)
      .run()
    expect(await flag(folioId)).toBe(true)

    // The admin switches business: the link now uses a retired key, which a broken current one
    // does not affect.
    await connectToFake(fake, org.adminEmail)
    await env.DB.prepare(`UPDATE devolada_connections SET status = 'broken', broken_reason = 'DEVOLADA_BUSINESS_SUSPENDED' WHERE organization_id = ?`)
      .bind(org.organizationId)
      .run()
    expect(await flag(folioId)).toBe(true)
  })
})

describe('spec edge cases', () => {
  it('the admin verifies by hand, then confirmed arrives: recorded, nothing signed or emailed twice', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    const manual = await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/verify`)
    expect(manual.status).toBe(200)
    const qr = (await call(org.adminEmail, 'GET', `/folios/${folioId}`)).json.folio.lines[0].qr_token
    await vi.waitFor(() => expect(emails.filter((m) => m.to === 'cliente@example.com')).toHaveLength(1))

    fake.advance(paymentId, 'confirmed')
    expect((await deliver(await fake.signedEvent(paymentId))).status).toBe(200)
    const detail = (await call(org.adminEmail, 'GET', `/folios/${folioId}`)).json
    expect(detail.folio.lines[0].qr_token).toBe(qr)
    expect(detail.folio.payment_links[0]).toMatchObject({ state: 'paid', label: 'confirmed' })
    expect(detail.events.filter((e: any) => e.type === 'payment_verified')).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 50))
    expect(emails.filter((m) => m.to === 'cliente@example.com')).toHaveLength(1)
  })

  it('a validating re-read applied over a stored confirmed one keeps confirmed and changes nothing', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    await deliver(await fake.signedEvent(paymentId))
    // Devolada answers an older state once (an out-of-order replica): the stored verdict stands.
    fake.payments.get(paymentId)!.status = 'validating'
    expect((await deliver(await fake.signedEvent(paymentId))).status).toBe(200)
    const stored = await env.DB.prepare(`SELECT status FROM devolada_payments WHERE devolada_payment_id = ?`)
      .bind(paymentId)
      .first<any>()
    expect(stored.status).toBe('confirmed')
    expect((await adminRow(folioId)).payment_link.label).toBe('confirmed')
  })
})
