// devolada-transfer-verification US3 — apartados: the deposit and the settlement each get their own
// enlace. A transfer deposit verifies only its own row; a settlement by transfer is a link request,
// recorded only once Devolada proves it (or the admin accepts it), and an unpaid settlement leaves
// the apartado intact. While its money is undecided, the apartado does not expire (FR-007, FR-016,
// FR-018; research D7, D8, D11, D15, D19, D21).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { sweepDevoladaPayments } from '../../src/routes/devolada/sweep'
import { applySettlement, planSettlement } from '../../src/routes/pos/settleCore'
import { sweepExpiredBookings } from '../../src/routes/pos/sweep'
import { stubResend } from '../helpers/auth-flows'
import { installFakeDevolada, type FakeDevolada } from '../helpers/devolada'
import { seedTwoOrgs } from '../helpers/tenancy'
import {
  PHONE,
  call,
  clearDevoladaDb,
  connectToFake,
  folioRow,
  linkRows,
  paymentRowsOf,
  seedSellers,
  seedSlot,
  type SeededSellers,
} from '../helpers/devoladaFixtures'

let fake: FakeDevolada
let org: SeededSellers

beforeEach(async () => {
  await clearDevoladaDb()
  stubResend()
  fake = await installFakeDevolada()
  org = await seedSellers('apartado')
})
afterEach(() => vi.restoreAllMocks())

const nowSec = () => Math.floor(Date.now() / 1000)

/** An apartado: a 45 000 deposit on 150 000 a line, by `method`; two lines when `slots` has two. */
const apartado = async (method: 'cash' | 'transfer', slots: string[] = [org.slotId], extra: Record<string, unknown> = {}) => {
  const res = await call(org.agentEmail, 'POST', '/pos/folios', {
    customer_name: 'Cliente Test',
    customer_phone: PHONE,
    customer_email: 'cliente@example.com',
    payment_method: method,
    down_payment: 45000,
    lines: slots.map((slot_id) => ({ slot_id, quantity: 1, unit_price: 150000 })),
    ...extra,
  })
  expect(res.status, res.text).toBe(201)
  return { folioId: res.json.folio.id as string, json: res.json }
}

const settle = (folioId: string, body: Record<string, unknown>, lineId?: string, email = org.agentEmail) =>
  call(email, 'POST', lineId ? `/pos/folios/${folioId}/lines/${lineId}/settle` : `/pos/folios/${folioId}/settle`, body)

const detail = async (folioId: string) => (await call(org.adminEmail, 'GET', `/folios/${folioId}`)).json.folio

const notify = async (paymentId: string) => {
  const res = await SELF.fetch(await fake.signedEvent(paymentId))
  expect(res.status).toBe(200)
}

const linesOf = async (folioId: string) =>
  (
    await env.DB.prepare(`SELECT * FROM folio_lines WHERE folio_id = ? ORDER BY rowid`).bind(folioId).all<any>()
  ).results

const ledger = async (folioId: string) =>
  (await env.DB.prepare(`SELECT * FROM folio_payments WHERE folio_id = ? ORDER BY rowid`).bind(folioId).all<any>())
    .results

const linkById = (id: string) => env.DB.prepare(`SELECT * FROM devolada_links WHERE id = ?`).bind(id).first<any>()

const storedPayment = (devoladaPaymentId: string) =>
  env.DB.prepare(`SELECT * FROM devolada_payments WHERE devolada_payment_id = ?`).bind(devoladaPaymentId).first<any>()

const resolve = (paymentId: string, action: string, email = org.adminEmail) =>
  call(email, 'POST', `/devolada/payments/${paymentId}/resolve`, { action })

/** Every live line (or one) past its clock AND its release time (departure − grace): due now. */
const makeDue = async (folioId: string, lineId?: string) => {
  const now = new Date()
  await env.DB.prepare(
    `UPDATE folio_lines SET slot_date = ?, slot_start_time = ?, booking_expires_at = ?
     WHERE folio_id = ? AND (? IS NULL OR id = ?)`,
  )
    .bind(now.toISOString().slice(0, 10), now.toISOString().slice(11, 16), nowSec() - 60, folioId, lineId ?? null, lineId ?? null)
    .run()
}

const liveLineIds = async (folioId: string) =>
  (await linesOf(folioId)).filter((l: any) => l.cancelled_at === null).map((l: any) => l.id)

describe('the deposit (D6, D7, D8)', () => {
  it('a transfer deposit gets its own link, for the deposit, expiring no later than the earliest line clock', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId, json } = await apartado('transfer')
    expect(json.payment_link).toMatchObject({ kind: 'deposit', amount: 45000, state: 'open' })
    const [link] = await linkRows(folioId)
    const [deposit] = await paymentRowsOf(folioId)
    expect(link).toMatchObject({ kind: 'deposit', amount: 45000, folio_payment_id: deposit.id })
    const clocks = (await linesOf(folioId)).map((l: any) => l.booking_expires_at as number)
    expect(link.expires_at).toBeLessThanOrEqual(Math.min(...clocks))
    // No reference is asked while connected (FR-009).
    expect(deposit.reference).toBeNull()
  })

  it('a confirmed deposit verifies only its own row: the sale stays an apartado, with no tickets', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('transfer')
    const [link] = await linkRows(folioId)
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    await notify(paymentId)
    const [deposit] = await paymentRowsOf(folioId)
    expect(deposit).toMatchObject({ verification: 'verified', verified_by: null })
    const folio = await detail(folioId)
    expect(folio.status).toBe('booking')
    for (const line of folio.lines) expect(line.qr_token ?? null).toBeNull()
    expect((await linkById(link.id)).state).toBe('paid')
  })
})

describe('settling by transfer records nothing until it is proven (D8)', () => {
  it('a connected settle answers the link and the apartado; a repeat returns the same link', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const rowsBefore = (await ledger(folioId)).length
    const res = await settle(folioId, { method: 'transfer' })
    expect(res.status, res.text).toBe(200)
    expect(res.json.folio.status).toBe('booking')
    expect(res.json.payment_link).toMatchObject({ kind: 'settlement', amount: 105000, folio_line_id: null })
    expect((await ledger(folioId)).length).toBe(rowsBefore)
    const allocations = await env.DB.prepare(
      `SELECT count(*) AS n FROM folio_payment_allocations a JOIN folio_payments p ON p.id = a.payment_id WHERE p.folio_id = ?`,
    )
      .bind(folioId)
      .first<any>()
    expect(allocations.n).toBe(1) // the deposit's only

    const again = await settle(folioId, { method: 'transfer' })
    expect(again.status).toBe(200)
    expect(again.json.payment_link.id).toBe(res.json.payment_link.id)
    expect((await linkRows(folioId)).filter((l: any) => l.kind === 'settlement')).toHaveLength(1)
  })

  it('a confirmed settlement records the money as the seller would have, verified by «Sistema», and releases the tickets', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = (await settle(folioId, { method: 'transfer' })).json.payment_link
    const row = await linkById(link.id)
    const paymentId = fake.submitProof(row.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    await notify(paymentId)

    const folio = await folioRow(folioId)
    expect(folio).toMatchObject({ settled_by: org.agentId, payment_verification: 'verified' })
    expect(folio.settled_at).not.toBeNull()
    const settlement = (await ledger(folioId)).find((r: any) => r.entry_type === 'payment' && r.method === 'transfer')
    const stored = await storedPayment(paymentId)
    expect(settlement).toMatchObject({
      amount: 105000,
      verification: 'verified',
      verified_by: null,
      collected_by: org.agentId,
      reference: stored.receipt_number,
      created_at: stored.verdict_at,
    })
    expect((await ledger(folioId)).filter((r: any) => r.entry_type === 'commission').length).toBeGreaterThan(1)
    expect(await linkById(link.id)).toMatchObject({ state: 'paid', folio_payment_id: settlement.id })
    const out = await detail(folioId)
    expect(out.status).toBe('paid')
    for (const line of out.lines) expect(line.qr_token).toBeTruthy()
    const events = await env.DB.prepare(
      `SELECT actor_id, payload FROM folio_events WHERE folio_id = ? AND event_type = 'payment'`,
    )
      .bind(folioId)
      .all<any>()
    expect(events.results.map((e) => ({ actor: e.actor_id, kind: JSON.parse(e.payload).kind }))).toContainEqual({
      actor: null,
      kind: 'settlement',
    })

    // A second delivery records nothing more.
    await notify(paymentId)
    expect((await ledger(folioId)).filter((r: any) => r.entry_type === 'payment')).toHaveLength(2)
  })

  it('two processors at once record one settlement: the link is the claim (constitution V)', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    const db = getDb(env)
    const scope = { organizationId: org.organizationId, folioId, folioLineId: null }
    // Both read the apartado before either writes: the webhook and the sweep, or a verdict and
    // the admin's accept.
    const plans = [await planSettlement(db, scope, { now: new Date() }), await planSettlement(db, scope, { now: new Date() })]
    const results = []
    for (const plan of plans) {
      results.push(
        await applySettlement({ db, env, waitUntil: () => {} }, plan, {
          method: 'transfer',
          reference: 'DV-1',
          verification: 'verified',
          verifiedBy: null,
          verifiedAt: new Date(),
          collectedBy: org.agentId,
          settledBy: org.agentId,
          actorId: null,
          at: new Date(),
          claim: { linkId: link.id, markPaid: true },
        }),
      )
    }
    expect(results.map((r) => r.recorded)).toEqual([true, false])
    const rows = await ledger(folioId)
    expect(rows.filter((r: any) => r.entry_type === 'payment')).toHaveLength(2)
    expect(rows.filter((r: any) => r.entry_type === 'commission')).toHaveLength(2)
    expect((await folioRow(folioId)).amount_paid).toBe(150000)
    const events = await env.DB.prepare(
      `SELECT count(*) AS n FROM folio_events WHERE folio_id = ? AND event_type = 'payment' AND payload LIKE '%"settlement"%'`,
    )
      .bind(folioId)
      .first<any>()
    expect(events.n).toBe(1)
  })

  it('a deposit still pending when the settlement is confirmed keeps the tickets until the deposit is confirmed', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('transfer')
    const [depositLink] = await linkRows(folioId)
    const settlementLink = (await settle(folioId, { method: 'transfer' })).json.payment_link
    const settlementPayment = fake.submitProof((await linkById(settlementLink.id)).devolada_link_id)
    fake.advance(settlementPayment, 'confirmed')
    await notify(settlementPayment)
    let folio = await detail(folioId)
    expect(folio.status).toBe('paid')
    for (const line of folio.lines) expect(line.qr_token ?? null).toBeNull()

    const depositPayment = fake.submitProof(depositLink.devolada_link_id)
    fake.advance(depositPayment, 'confirmed')
    await notify(depositPayment)
    folio = await detail(folioId)
    for (const line of folio.lines) expect(line.qr_token).toBeTruthy()
  })

  it('one line settles by its own link, bounded by that line alone even when an earlier line is past its clock', async () => {
    await connectToFake(fake, org.adminEmail)
    const later = await seedSlot(org.organizationId, org.serviceId, { daysAhead: 5 })
    const { folioId } = await apartado('cash', [org.slotId, later])
    const [first, second] = await linesOf(folioId)
    await env.DB.prepare(`UPDATE folio_lines SET booking_expires_at = ? WHERE id = ?`).bind(nowSec() - 60, first.id).run()

    const res = await settle(folioId, { method: 'transfer' }, second.id)
    expect(res.status, res.text).toBe(200)
    expect(res.json.payment_link).toMatchObject({ kind: 'settlement', folio_line_id: second.id })
    const link = await linkById(res.json.payment_link.id)
    expect(link.expires_at).toBeLessThanOrEqual(second.booking_expires_at)
    expect(link.expires_at).toBeGreaterThan(nowSec() + 15 * 60)

    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    await notify(paymentId)
    const lines = await linesOf(folioId)
    const settled = lines.find((l: any) => l.id === second.id)
    const allocated = await env.DB.prepare(`SELECT sum(amount) AS s FROM folio_payment_allocations WHERE folio_line_id = ?`)
      .bind(second.id)
      .first<any>()
    expect(allocated.s).toBe(settled.line_total)
    expect(settled.qr_token).toBeTruthy()
    expect(lines.find((l: any) => l.id === first.id).qr_token).toBeNull()
    expect((await detail(folioId)).status).toBe('booking')
  })

  it('an unpaid settlement link expires, and the apartado stays as it was', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    await sweepDevoladaPayments(env, new Date((link.expires_at + 60) * 1000))
    expect((await linkById(link.id)).state).toBe('expired')
    expect(await folioRow(folioId)).toMatchObject({ cancelled_at: null, settled_at: null })
    expect((await detail(folioId)).status).toBe('booking')
  })

  it('when no link can be created, today\'s manual settlement is recorded, and the answer says why', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    fake.failNext('createPaymentLink', '500')
    const res = await settle(folioId, { method: 'transfer' })
    expect(res.status, res.text).toBe(200)
    expect(res.json).toMatchObject({ payment_link: null, payment_link_error: 'DEVOLADA_UNAVAILABLE' })
    const settlement = (await ledger(folioId)).find((r: any) => r.entry_type === 'payment' && r.method === 'transfer')
    expect(settlement).toMatchObject({ amount: 105000, verification: 'pending' })
    expect((await folioRow(folioId)).payment_verification).toBe('pending')
  })

  it('a settlement after departure — the link would stay open under 15 minutes — is recorded by hand', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    // The departure passed an hour ago; the organization's negative grace keeps the clock open.
    const departed = new Date(Date.now() - 3600_000)
    await env.DB.prepare(`UPDATE folio_lines SET slot_date = ?, slot_start_time = ?, booking_expires_at = ? WHERE folio_id = ?`)
      .bind(departed.toISOString().slice(0, 10), departed.toISOString().slice(11, 16), nowSec() + 3600, folioId)
      .run()
    const res = await settle(folioId, { method: 'transfer' })
    expect(res.status, res.text).toBe(200)
    expect(res.json).toMatchObject({ payment_link: null, payment_link_error: 'PAYMENT_LINK_TOO_SHORT' })
    expect((await linkRows(folioId)).find((l: any) => l.kind === 'settlement').state).toBe('failed')
    expect(fake.callsTo('createPaymentLink')).toHaveLength(1) // the connect probe only
  })
})

// A cash settlement or a line cancellation while a settlement link is open closes or keeps that link
// by what it touches (US4, D13): test/devolada/link-closing.test.ts.
describe('one settlement link per sale (D8)', () => {
  it("with one line's link open, a transfer of another scope waits; the same line's transfer gets its link back", async () => {
    await connectToFake(fake, org.adminEmail)
    const later = await seedSlot(org.organizationId, org.serviceId, { daysAhead: 5 })
    const { folioId } = await apartado('cash', [org.slotId, later])
    const [first, second] = await linesOf(folioId)
    const link = (await settle(folioId, { method: 'transfer' }, second.id)).json.payment_link
    const before = (await ledger(folioId)).length

    for (const refused of [
      await settle(folioId, { method: 'transfer' }, first.id),
      await settle(folioId, { method: 'transfer' }),
    ]) {
      expect(refused.status, refused.text).toBe(409)
      expect(refused.json.error.code).toBe('SETTLEMENT_IN_PROGRESS')
    }
    expect((await ledger(folioId)).length).toBe(before)
    expect(await liveLineIds(folioId)).toHaveLength(2)
    const same = await settle(folioId, { method: 'transfer' }, second.id)
    expect(same.status).toBe(200)
    expect(same.json.payment_link.id).toBe(link.id)
  })

  it("with the whole sale's link open, one line's transfer waits too", async () => {
    await connectToFake(fake, org.adminEmail)
    const later = await seedSlot(org.organizationId, org.serviceId, { daysAhead: 5 })
    const { folioId } = await apartado('cash', [org.slotId, later])
    const [first] = await linesOf(folioId)
    expect((await settle(folioId, { method: 'transfer' })).status).toBe(200)
    const refused = await settle(folioId, { method: 'transfer' }, first.id)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('SETTLEMENT_IN_PROGRESS')
  })
})

describe('the admin decides a settlement Devolada could not (D15)', () => {
  const exception = async (status: 'partial' | 'invalid' = 'partial') => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    const paymentId = fake.submitProof(link.devolada_link_id)
    if (status === 'partial') fake.advance(paymentId, 'partial', 50000)
    else fake.advance(paymentId, 'invalid')
    await notify(paymentId)
    return { folioId, link, payment: await storedPayment(paymentId) }
  }

  it('partial or invalid closes the link and waits for the admin', async () => {
    const { folioId, link } = await exception('invalid')
    await vi.waitFor(async () => expect((await linkById(link.id)).state).toBe('closed'))
    expect(fake.link(link.devolada_link_id).closedAt).not.toBeNull()
    const row = (await call(org.adminEmail, 'GET', '/folios')).json.folios.find((f: any) => f.id === folioId)
    expect(row).toMatchObject({ devolada_attention: true })
    expect((await call(org.adminEmail, 'GET', '/folios/counts')).json.devolada_attention).toBe(1)
  })

  it('accept records the settlement as the admin, and the tickets go out', async () => {
    const { folioId, link, payment } = await exception()
    const res = await resolve(payment.id, 'accept')
    expect(res.status, res.text).toBe(200)
    expect(res.json.folio).toMatchObject({ status: 'paid', devolada_attention: false })
    const settlement = (await ledger(folioId)).find((r: any) => r.entry_type === 'payment' && r.method === 'transfer')
    expect(settlement).toMatchObject({ amount: 105000, verification: 'verified', verified_by: org.adminId, collected_by: org.agentId })
    expect(await storedPayment(payment.devolada_payment_id)).toMatchObject({ resolution: 'accepted', resolved_by: org.adminId })
    expect((await linkById(link.id)).folio_payment_id).toBe(settlement.id)
    for (const line of (await detail(folioId)).lines) expect(line.qr_token).toBeTruthy()
    // A double tap writes nothing.
    expect((await resolve(payment.id, 'accept')).status).toBe(409)
    expect((await ledger(folioId)).filter((r: any) => r.entry_type === 'payment')).toHaveLength(2)
  })

  it('dismiss keeps the apartado as it was', async () => {
    const { folioId, payment } = await exception()
    const res = await resolve(payment.id, 'dismiss')
    expect(res.status, res.text).toBe(200)
    expect(res.json.folio).toMatchObject({ status: 'booking', devolada_attention: false })
    expect(await storedPayment(payment.devolada_payment_id)).toMatchObject({ resolution: 'dismissed' })
  })

  it('once the apartado was settled in cash meanwhile, accept is refused and dismiss clears it', async () => {
    const { folioId, link, payment } = await exception()
    await vi.waitFor(async () => expect((await linkById(link.id)).state).toBe('closed'))
    expect((await settle(folioId, { method: 'cash' })).status).toBe(200)
    const accept = await resolve(payment.id, 'accept')
    expect(accept.status).toBe(409)
    expect(accept.json.error.code).toBe('DEVOLADA_PAYMENT_NOT_RESOLVABLE')
    expect((await resolve(payment.id, 'dismiss')).status).toBe(200)
  })

  it('a settlement still in flight: accept records it, the link stays open, and its verdict records nothing more', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.setAwaiting(paymentId)
    await notify(paymentId)
    const payment = await storedPayment(paymentId)
    const dismiss = await resolve(payment.id, 'dismiss')
    expect(dismiss.status).toBe(409)

    const res = await resolve(payment.id, 'accept')
    expect(res.status, res.text).toBe(200)
    expect(res.json.folio.status).toBe('paid')
    expect(await linkById(link.id)).toMatchObject({ state: 'open' })

    fake.advance(paymentId, 'confirmed')
    await notify(paymentId)
    expect((await linkById(link.id)).state).toBe('paid')
    expect((await ledger(folioId)).filter((r: any) => r.entry_type === 'payment')).toHaveLength(2)
  })

  it("after the apartado's clock ran out, accept still records a payment submitted before its link expired", async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'invalid')
    await notify(paymentId)
    await env.DB.prepare(`UPDATE folio_lines SET booking_expires_at = ? WHERE folio_id = ?`).bind(nowSec() - 60, folioId).run()
    const res = await resolve((await storedPayment(paymentId)).id, 'accept')
    expect(res.status, res.text).toBe(200)
    expect(res.json.folio.status).toBe('paid')
  })

  it('a confirmed settlement submitted in time is recorded after the clock ran out', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    const paymentId = fake.submitProof(link.devolada_link_id)
    await env.DB.prepare(`UPDATE folio_lines SET booking_expires_at = ? WHERE folio_id = ?`).bind(nowSec() - 60, folioId).run()
    fake.advance(paymentId, 'confirmed')
    await notify(paymentId)
    expect((await detail(folioId)).status).toBe('paid')
  })

  it('a settlement link no key can read fails; its payment in flight goes to the admin, who accepts or dismisses it', async () => {
    const first = await connectToFake(fake, org.adminEmail)
    const accepted = await apartado('cash')
    const dismissed = await apartado('cash', [await seedSlot(org.organizationId, org.serviceId, { daysAhead: 4 })])
    const payments: string[] = []
    for (const { folioId } of [accepted, dismissed]) {
      const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
      const paymentId = fake.submitProof(link.devolada_link_id)
      await notify(paymentId)
      payments.push(paymentId)
    }
    // A switch to another business, whose key cannot read these links; the old key is revoked.
    await connectToFake(fake, org.adminEmail)
    fake.revokeKey(first.apiKey)
    await sweepDevoladaPayments(env, new Date(Date.now() + 11 * 60_000))
    for (const { folioId } of [accepted, dismissed]) {
      const [link] = (await linkRows(folioId)).filter((l: any) => l.kind === 'settlement')
      expect(link.state).toBe('failed')
      const row = (await call(org.adminEmail, 'GET', '/folios')).json.folios.find((f: any) => f.id === folioId)
      expect(row).toMatchObject({ devolada_attention: true, payment_link: { label: 'link_failed' } })
    }
    const accept = await resolve((await storedPayment(payments[0]!)).id, 'accept')
    expect(accept.status, accept.text).toBe(200)
    expect(accept.json.folio.status).toBe('paid')
    const closesBefore = fake.callsTo('closePaymentLink').length
    const dismiss = await resolve((await storedPayment(payments[1]!)).id, 'dismiss')
    expect(dismiss.status, dismiss.text).toBe(200)
    expect(dismiss.json.folio.status).toBe('booking')
    expect(fake.callsTo('closePaymentLink')).toHaveLength(closesBefore)
  })
})

describe('the deposit link expires unpaid while the settlement link is open (D11)', () => {
  it('with the settlement payment validating, nothing is cancelled', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('transfer')
    const [depositLink] = await linkRows(folioId)
    const settlementLink = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    await notify(fake.submitProof(settlementLink.devolada_link_id))
    const depositPayment = fake.submitProof(depositLink.devolada_link_id)
    fake.advance(depositPayment, 'expired')
    await notify(depositPayment)
    expect((await folioRow(folioId)).cancelled_at).toBeNull()
    expect((await linkById(settlementLink.id)).state).toBe('open')
  })

  it('with no settlement payment, the sale is cancelled and its settlement link closed as cancelled', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('transfer')
    const [depositLink] = await linkRows(folioId)
    const settlementLink = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    const depositPayment = fake.submitProof(depositLink.devolada_link_id)
    fake.advance(depositPayment, 'expired')
    await notify(depositPayment)
    expect((await folioRow(folioId)).cancellation_source).toBe('payment_not_received')
    await vi.waitFor(async () =>
      expect(await linkById(settlementLink.id)).toMatchObject({ state: 'closed', closed_reason: 'cancelled' }),
    )
  })
})

describe('the apartado expiry sweep holds an apartado whose money is undecided (D8)', () => {
  it('a sale or deposit link open holds every line; the same apartado without it is released', async () => {
    const control = await apartado('cash')
    await connectToFake(fake, org.adminEmail)
    const held = await apartado('transfer', [await seedSlot(org.organizationId, org.serviceId, { daysAhead: 4 })])
    await makeDue(control.folioId)
    await makeDue(held.folioId)
    await sweepExpiredBookings(env)
    expect(await liveLineIds(control.folioId)).toHaveLength(0)
    expect(await liveLineIds(held.folioId)).toHaveLength(1)
  })

  it('a pending deposit a link collects holds it whatever the link became, until it is decided', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('transfer')
    const [link] = await linkRows(folioId)
    await env.DB.prepare(`UPDATE devolada_links SET state = 'failed' WHERE id = ?`).bind(link.id).run()
    await makeDue(folioId)
    await sweepExpiredBookings(env)
    expect(await liveLineIds(folioId)).toHaveLength(1)

    // The admin's Verificar decides it: the apartado expires as usual.
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/verify`)).status).toBe(200)
    await sweepExpiredBookings(env)
    expect(await liveLineIds(folioId)).toHaveLength(0)
  })

  it("a whole-sale settlement link open, or its payment awaiting the admin, holds every line; once dismissed it expires", async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    await makeDue(folioId)
    await sweepExpiredBookings(env)
    expect(await liveLineIds(folioId)).toHaveLength(1)

    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'partial', 50000)
    await notify(paymentId)
    await vi.waitFor(async () => expect((await linkById(link.id)).state).toBe('closed'))
    await sweepExpiredBookings(env)
    expect(await liveLineIds(folioId)).toHaveLength(1)

    expect((await resolve((await storedPayment(paymentId)).id, 'dismiss')).status).toBe(200)
    await sweepExpiredBookings(env)
    expect(await liveLineIds(folioId)).toHaveLength(0)
  })

  it('a stale validating snapshot on a link that no longer takes money never holds it', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    await notify(fake.submitProof(link.devolada_link_id))
    await env.DB.prepare(`UPDATE devolada_links SET state = 'expired' WHERE id = ?`).bind(link.id).run()
    await makeDue(folioId)
    await sweepExpiredBookings(env)
    expect(await liveLineIds(folioId)).toHaveLength(0)
  })

  it('a held apartado gets no grace notice between its clock and its release time', async () => {
    const control = await apartado('cash')
    await connectToFake(fake, org.adminEmail)
    const held = await apartado('transfer', [await seedSlot(org.organizationId, org.serviceId, { daysAhead: 4 })])
    const departure = new Date(Date.now() + 2 * 3600_000)
    for (const { folioId } of [control, held]) {
      await env.DB.prepare(`UPDATE folio_lines SET slot_date = ?, slot_start_time = ?, booking_expires_at = ? WHERE folio_id = ?`)
        .bind(departure.toISOString().slice(0, 10), departure.toISOString().slice(11, 16), nowSec() - 60, folioId)
        .run()
    }
    await sweepExpiredBookings(env)
    const notices = async (folioId: string) =>
      (
        await env.DB.prepare(`SELECT count(*) AS n FROM notifications WHERE folio_id = ? AND event = 'booking_grace_entered'`)
          .bind(folioId)
          .first<any>()
      ).n
    expect(await notices(control.folioId)).toBeGreaterThan(0)
    expect(await notices(held.folioId)).toBe(0)
  })

  it("one line's own settlement holds only that line: its sibling is released at its own time", async () => {
    await connectToFake(fake, org.adminEmail)
    const later = await seedSlot(org.organizationId, org.serviceId, { daysAhead: 5 })
    const { folioId } = await apartado('cash', [org.slotId, later])
    const [first, second] = await linesOf(folioId)
    const link = (await settle(folioId, { method: 'transfer' }, second.id)).json.payment_link
    await makeDue(folioId)
    await sweepExpiredBookings(env)
    expect(await liveLineIds(folioId)).toEqual([second.id])
    expect((await linkById(link.id)).state).toBe('open')
    expect((await linesOf(folioId)).find((l: any) => l.id === first.id).cancellation_source).toBe('system_expiry')
  })
})

describe('isolation (constitution III)', () => {
  it("another organization's admin cannot resolve, and its seller cannot settle, this apartado", async () => {
    const { orgB } = await seedTwoOrgs()
    await connectToFake(fake, org.adminEmail)
    const { folioId } = await apartado('cash')
    const link = await linkById((await settle(folioId, { method: 'transfer' })).json.payment_link.id)
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'invalid')
    await notify(paymentId)
    const payment = await storedPayment(paymentId)
    for (const action of ['accept', 'dismiss', 'returned']) {
      expect((await resolve(payment.id, action, orgB.adminEmail)).status).toBe(404)
    }
    expect((await settle(folioId, { method: 'cash' }, undefined, orgB.adminEmail)).status).toBe(404)
    expect((await call(orgB.adminEmail, 'GET', '/folios/counts')).json.devolada_attention).toBe(0)
    expect(await storedPayment(paymentId)).toMatchObject({ resolution: null })
  })
})
