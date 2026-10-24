// devolada-transfer-verification US4 — a sale that stops taking money closes its links: inside the
// write's own batch, with the reason, then at Devolada. A line cancellation that changes an
// apartado's balance replaces its settlement link, and no write closes a link under a payment in
// flight while the sale lives (FR-011, FR-012; research D9, D12, D13, D15).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { sweepDevoladaPayments } from '../../src/routes/devolada/sweep'
import { planSettlement } from '../../src/routes/pos/settleCore'
import { stubResend } from '../helpers/auth-flows'
import { installFakeDevolada, type FakeDevolada } from '../helpers/devolada'
import { seedTwoOrgs } from '../helpers/tenancy'
import {
  PHONE,
  call,
  clearDevoladaDb,
  connectToFake,
  counts,
  currentCredentialId,
  folioRow,
  insertLink,
  linkRows,
  seedSellers,
  seedSlot,
  sellByTransfer,
  type SeededSellers,
} from '../helpers/devoladaFixtures'

let fake: FakeDevolada
let org: SeededSellers

beforeEach(async () => {
  await clearDevoladaDb()
  stubResend()
  fake = await installFakeDevolada()
  org = await seedSellers('closing')
  await connectToFake(fake, org.adminEmail)
})
afterEach(() => vi.restoreAllMocks())

/** An apartado: a 45 000 deposit on 150 000 a line, by `method`; one line per slot. */
const apartado = async (method: 'cash' | 'transfer', slots: string[] = [org.slotId]) => {
  const res = await call(org.agentEmail, 'POST', '/pos/folios', {
    customer_name: 'Cliente Test',
    customer_phone: PHONE,
    customer_email: 'cliente@example.com',
    payment_method: method,
    down_payment: 45000,
    lines: slots.map((slot_id) => ({ slot_id, quantity: 1, unit_price: 150000 })),
  })
  expect(res.status, res.text).toBe(201)
  return res.json.folio.id as string
}

/** A two-line apartado (three and five days out), paid down in cash. */
const twoLines = async () => {
  const later = await seedSlot(org.organizationId, org.serviceId, { daysAhead: 5 })
  const folioId = await apartado('cash', [org.slotId, later])
  const [first, second] = await linesOf(folioId)
  return { folioId, first: first.id as string, second: second.id as string }
}

const settle = (folioId: string, body: Record<string, unknown>, lineId?: string, email = org.agentEmail) =>
  call(email, 'POST', lineId ? `/pos/folios/${folioId}/lines/${lineId}/settle` : `/pos/folios/${folioId}/settle`, body)

/** The settlement link a transfer settle issues: of the whole sale, or of one line. */
const settlementLink = async (folioId: string, lineId?: string) => {
  const res = await settle(folioId, { method: 'transfer' }, lineId)
  expect(res.status, res.text).toBe(200)
  return linkById(res.json.payment_link.id)
}

const cancelLine = (folioId: string, lineId: string, by: 'agent' | 'admin' = 'agent', email?: string) =>
  by === 'agent'
    ? call(email ?? org.agentEmail, 'POST', `/pos/folios/${folioId}/lines/${lineId}/cancel`, {})
    : call(email ?? org.adminEmail, 'POST', `/folios/${folioId}/lines/${lineId}/cancel`, {})

const notify = async (paymentId: string) => {
  const res = await SELF.fetch(await fake.signedEvent(paymentId))
  expect(res.status).toBe(200)
}

/** The customer submits proof, and Devolada's `validating` reaches us: a payment in flight. */
const inFlight = async (link: { devolada_link_id: string }) => {
  const paymentId = fake.submitProof(link.devolada_link_id)
  await notify(paymentId)
  return paymentId
}

const linkById = (id: string) => env.DB.prepare(`SELECT * FROM devolada_links WHERE id = ?`).bind(id).first<any>()

const linesOf = async (folioId: string) =>
  (await env.DB.prepare(`SELECT * FROM folio_lines WHERE folio_id = ? ORDER BY rowid`).bind(folioId).all<any>())
    .results

const ledger = async (folioId: string) =>
  (await env.DB.prepare(`SELECT * FROM folio_payments WHERE folio_id = ? ORDER BY rowid`).bind(folioId).all<any>())
    .results

const storedPayment = (devoladaPaymentId: string) =>
  env.DB.prepare(`SELECT * FROM devolada_payments WHERE devolada_payment_id = ?`).bind(devoladaPaymentId).first<any>()

const detail = async (folioId: string) => (await call(org.adminEmail, 'GET', `/folios/${folioId}`)).json.folio

const viewOf = async (folioId: string, linkId: string) =>
  (await detail(folioId)).payment_links.find((l: any) => l.id === linkId)

/** The link ends `closed`, after Devolada acknowledged a close sent with its own key. */
const closedAtDevolada = async (link: { id: string; devolada_link_id: string }) => {
  await vi.waitFor(async () => expect((await linkById(link.id)).state).toBe('closed'))
  expect(fake.link(link.devolada_link_id).closedAt).not.toBeNull()
  expect(fake.callsTo('closePaymentLink').some((c) => c.idempotencyKey === `close:${link.id}`)).toBe(true)
}

const ticketNotices = async (folioId: string) =>
  (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE folio_id = ? AND event = 'tickets_delivered'`)
      .bind(folioId)
      .first<any>()
  ).n as number

describe('every cancellation closes the sale’s open links (D13)', () => {
  const requestCancellation = async (folioId: string) => {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO folio_requests (id, organization_id, folio_id, kind, status, reason) VALUES (?, ?, ?, 'cancellation', 'pending', 'Cambio de planes')`,
    )
      .bind(id, org.organizationId, folioId)
      .run()
    return id
  }

  it.each([
    ['an admin', (folioId: string) => call(org.adminEmail, 'POST', `/folios/${folioId}/cancel`, {})],
    ['the seller', (folioId: string) => call(org.agentEmail, 'POST', `/pos/folios/${folioId}/cancel`, {})],
    [
      "the approval of the customer's request",
      async (folioId: string) => call(org.adminEmail, 'POST', `/folios/requests/${await requestCancellation(folioId)}/approve`),
    ],
  ])('cancelled by %s, an open settlement link closes as `cancelled`, then at Devolada', async (_, cancel) => {
    const folioId = await apartado('cash')
    const link = await settlementLink(folioId)
    const res = await cancel(folioId)
    expect(res.status, res.text).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ closed_reason: 'cancelled' })
    await closedAtDevolada(link)
  })
})

describe('a line cancellation closes what it changes, and replaces a whole-sale link (D13)', () => {
  it.each(['agent', 'admin'] as const)(
    'by the %s: the whole-sale link closes as `amount_changed`, and the answer carries its replacement for the new balance',
    async (by) => {
      const { folioId, first } = await twoLines()
      const old = await settlementLink(folioId)
      const res = await cancelLine(folioId, first, by)
      expect(res.status, res.text).toBe(200)

      expect(await linkById(old.id)).toMatchObject({ closed_reason: 'amount_changed' })
      await closedAtDevolada(old)
      const plan = await planSettlement(
        getDb(env),
        { organizationId: org.organizationId, folioId, folioLineId: null },
        { now: new Date() },
      )
      expect(res.json.payment_link).toMatchObject({ kind: 'settlement', folio_line_id: null, state: 'open', amount: plan.amount })
      expect(plan.amount).toBeLessThan(old.amount)
      // Issued by the seller who issued the first link, who collects the settlement (D8).
      expect(await linkById(res.json.payment_link.id)).toMatchObject({ requested_by: org.agentId })
      expect(fake.link((await linkById(res.json.payment_link.id)).devolada_link_id).askCents).toBe(plan.amount)
    },
  )

  it('no replacement once the sale no longer owes: its other line was settled in cash', async () => {
    const { folioId, first, second } = await twoLines()
    expect((await settle(folioId, { method: 'cash' }, second)).status).toBe(200)
    const old = await settlementLink(folioId)
    const res = await cancelLine(folioId, first)
    expect(res.status, res.text).toBe(200)
    expect(await linkById(old.id)).toMatchObject({ closed_reason: 'amount_changed' })
    expect(res.json).not.toHaveProperty('payment_link')
    expect((await linkRows(folioId)).filter((l: any) => l.state === 'open')).toHaveLength(0)
  })

  it('when the replacement cannot be created, the answer says why', async () => {
    const { folioId, first } = await twoLines()
    await settlementLink(folioId)
    fake.failNext('createPaymentLink', '500')
    const res = await cancelLine(folioId, first)
    expect(res.status, res.text).toBe(200)
    expect(res.json).toMatchObject({ payment_link: null, payment_link_error: 'DEVOLADA_UNAVAILABLE' })
  })

  it("a line's own link closes as `cancelled` with its line, without a replacement", async () => {
    const { folioId, second } = await twoLines()
    const link = await settlementLink(folioId, second)
    const res = await cancelLine(folioId, second)
    expect(res.status, res.text).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ closed_reason: 'cancelled' })
    expect(res.json).not.toHaveProperty('payment_link')
    await closedAtDevolada(link)
  })

  it("a line's own link stays open when another line is cancelled", async () => {
    const { folioId, first, second } = await twoLines()
    const link = await settlementLink(folioId, second)
    const res = await cancelLine(folioId, first, 'admin')
    expect(res.status, res.text).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ state: 'open', closed_reason: null })
    expect(res.json).not.toHaveProperty('payment_link')
    expect(fake.callsTo('closePaymentLink')).toHaveLength(0)
  })
})

describe('the other writes that stop a sale taking a payment close its link, with the reason (D13)', () => {
  const transferSale = async () => {
    const res = await sellByTransfer(org.agentEmail, org.slotId, { customer_email: 'cliente@example.com' })
    expect(res.status, res.text).toBe(201)
    const [link] = await linkRows(res.json.folio.id)
    return { folioId: res.json.folio.id as string, link }
  }

  it('Rechazar: `rejected`', async () => {
    const { folioId, link } = await transferSale()
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/reject`, {})).status).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ closed_reason: 'rejected' })
    await closedAtDevolada(link)
  })

  it('Verificar, for the links of the rows it verified: `verified_by_admin`', async () => {
    const { folioId, link } = await transferSale()
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/verify`)).status).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ closed_reason: 'verified_by_admin' })
    await closedAtDevolada(link)
  })

  it("verifying a deposit by hand leaves the sale's settlement link open: it collects no row", async () => {
    const folioId = await apartado('transfer')
    const [deposit] = await linkRows(folioId)
    const settlement = await settlementLink(folioId)
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/verify`)).status).toBe(200)
    expect(await linkById(deposit.id)).toMatchObject({ closed_reason: 'verified_by_admin' })
    expect(await linkById(settlement.id)).toMatchObject({ state: 'open', closed_reason: null })
  })

  // What a cash settlement settles, and the settlement link it closes (`settled_otherwise`).
  it.each([
    ['the whole sale', 'a whole-sale link', null, null, true],
    ['one line', 'a whole-sale link', 'first', null, true],
    ['that line', "a line's own link", 'second', 'second', true],
    ['the whole sale', "a line's own link", null, 'second', true],
    ['another line', "a line's own link", 'first', 'second', false],
  ] as const)('a cash settlement of %s and %s: closed %s', async (_, __, settled, linked, closes) => {
    const lines = await twoLines()
    const link = await settlementLink(lines.folioId, linked ? lines[linked] : undefined)
    const res = await settle(lines.folioId, { method: 'cash' }, settled ? lines[settled] : undefined)
    expect(res.status, res.text).toBe(200)
    if (closes) {
      expect(await linkById(link.id)).toMatchObject({ closed_reason: 'settled_otherwise' })
      await closedAtDevolada(link)
    } else {
      expect(await linkById(link.id)).toMatchObject({ state: 'open', closed_reason: null })
    }
  })

  it("D11: its own link ends `expired`, with no reason; the sale's other links `cancelled`", async () => {
    const folioId = await apartado('transfer')
    const [deposit] = await linkRows(folioId)
    const settlement = await settlementLink(folioId)
    const paymentId = fake.submitProof(deposit.devolada_link_id)
    fake.advance(paymentId, 'expired')
    await notify(paymentId)
    expect(await linkById(deposit.id)).toMatchObject({ state: 'expired', closed_reason: null })
    expect(await linkById(settlement.id)).toMatchObject({ closed_reason: 'cancelled' })
    await closedAtDevolada(settlement)
  })
})

describe('never under a payment in flight while the sale lives (D13)', () => {
  const transferSale = async () => {
    const res = await sellByTransfer(org.agentEmail, org.slotId, { customer_email: 'cliente@example.com' })
    const [link] = await linkRows(res.json.folio.id)
    return { folioId: res.json.folio.id as string, link }
  }

  /** The admin verifies by hand while the link's payment is validating: the link stays open. */
  const verifiedInFlight = async () => {
    const { folioId, link } = await transferSale()
    const paymentId = await inFlight(link)
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/verify`)).status).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ state: 'open', closed_reason: null })
    return { folioId, link, paymentId }
  }

  it('Verificar during validation leaves the link open; its confirmed verdict releases nothing again and ends it `paid`', async () => {
    const { folioId, link, paymentId } = await verifiedInFlight()
    const qr = (await linesOf(folioId))[0].qr_token
    const notices = await ticketNotices(folioId)
    expect(qr).not.toBeNull()
    expect(notices).toBeGreaterThan(0)
    fake.advance(paymentId, 'confirmed')
    await notify(paymentId)
    expect((await linkById(link.id)).state).toBe('paid')
    expect((await linesOf(folioId))[0].qr_token).toBe(qr)
    expect(await ticketNotices(folioId)).toBe(notices)
    expect(fake.callsTo('closePaymentLink')).toHaveLength(0)
  })

  it('…an invalid verdict closes it as `verified_by_admin`', async () => {
    const { link, paymentId } = await verifiedInFlight()
    fake.advance(paymentId, 'invalid')
    await notify(paymentId)
    expect(await linkById(link.id)).toMatchObject({ closed_reason: 'verified_by_admin' })
    await closedAtDevolada(link)
  })

  it('…an expired one cancels nothing', async () => {
    const { folioId, link, paymentId } = await verifiedInFlight()
    fake.advance(paymentId, 'expired')
    await notify(paymentId)
    expect((await folioRow(folioId)).cancelled_at).toBeNull()
    expect((await linkById(link.id)).state).toBe('expired')
  })

  it("while one line's link has a payment in flight, the writes that would close it answer 409 and change nothing; another line's settlement goes ahead", async () => {
    const { folioId, first, second } = await twoLines()
    const link = await settlementLink(folioId, second)
    await inFlight(link)
    const before = (await ledger(folioId)).length
    for (const refused of [
      await cancelLine(folioId, second),
      await cancelLine(folioId, second, 'admin'),
      await settle(folioId, { method: 'cash' }, second),
      await settle(folioId, { method: 'cash' }),
    ]) {
      expect(refused.status, refused.text).toBe(409)
      expect(refused.json.error.code).toBe('SETTLEMENT_IN_PROGRESS')
    }
    expect((await ledger(folioId)).length).toBe(before)
    expect((await linesOf(folioId)).every((l: any) => l.cancelled_at === null)).toBe(true)

    expect((await settle(folioId, { method: 'cash' }, first)).status).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ state: 'open', closed_reason: null })
  })

  it("while the whole sale's link has a payment in flight, a line cancellation or a cash settlement waits", async () => {
    const { folioId, first } = await twoLines()
    const link = await settlementLink(folioId)
    await inFlight(link)
    for (const refused of [
      await cancelLine(folioId, first),
      await cancelLine(folioId, first, 'admin'),
      await settle(folioId, { method: 'cash' }, first),
      await settle(folioId, { method: 'cash' }),
    ]) {
      expect(refused.status, refused.text).toBe(409)
      expect(refused.json.error.code).toBe('SETTLEMENT_IN_PROGRESS')
    }
    expect(await linkById(link.id)).toMatchObject({ state: 'open', closed_reason: null })
    expect((await linkRows(folioId)).filter((l: any) => l.kind === 'settlement')).toHaveLength(1)
  })

  it.each([
    ['cancelling the sale', (folioId: string) => call(org.agentEmail, 'POST', `/pos/folios/${folioId}/cancel`, {}), 'cancelled'],
    ['Rechazar', (folioId: string) => call(org.adminEmail, 'POST', `/pos/folios/${folioId}/reject`, {}), 'rejected'],
  ] as const)('%s closes the link even with a payment in flight; that payment arrives as money to return', async (_, write, reason) => {
    const { folioId, link } =
      reason === 'rejected'
        ? await transferSale()
        : await (async () => {
            const id = await apartado('cash')
            return { folioId: id, link: await settlementLink(id) }
          })()
    const paymentId = await inFlight(link)
    expect((await write(folioId)).status).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ closed_reason: reason })
    await closedAtDevolada(link)

    fake.advance(paymentId, 'unapplied')
    await notify(paymentId)
    expect(await viewOf(folioId, link.id)).toMatchObject({ label: 'unapplied' })
    expect((await detail(folioId)).devolada_attention).toBe(true)
  })

  it("cancelling the sale keeps a link whose money it already holds open while its payment is in flight; the verdict ends it `paid`", async () => {
    const folioId = await apartado('transfer')
    const [deposit] = await linkRows(folioId)
    const paymentId = await inFlight(deposit)
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/verify`)).status).toBe(200)
    expect((await call(org.agentEmail, 'POST', `/pos/folios/${folioId}/cancel`, {})).status).toBe(200)
    expect(await linkById(deposit.id)).toMatchObject({ state: 'open', closed_reason: null })

    fake.advance(paymentId, 'confirmed')
    await notify(paymentId)
    expect((await linkById(deposit.id)).state).toBe('paid')
    expect(await viewOf(folioId, deposit.id)).toMatchObject({ label: 'confirmed' })
    expect((await detail(folioId)).devolada_attention).toBe(false)
  })
})

describe('a confirmed payment on a link a write closed first settles nothing: money to return (D9, D13)', () => {
  it.each([
    ['a cash settlement', (folioId: string) => settle(folioId, { method: 'cash' }), 'settled_otherwise'],
    ['a line cancellation', async (folioId: string) => cancelLine(folioId, (await linesOf(folioId))[0].id), 'amount_changed'],
  ] as const)('after %s', async (_, write, reason) => {
    const { folioId } = await twoLines()
    const link = await settlementLink(folioId)
    // The customer paid just before the write, and Devolada's word had not reached us yet.
    const paymentId = fake.submitProof(link.devolada_link_id)
    expect((await write(folioId)).status).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ closed_reason: reason })
    const before = (await ledger(folioId)).length

    fake.advance(paymentId, 'confirmed')
    await notify(paymentId)
    expect((await ledger(folioId)).length).toBe(before)
    expect((await linkById(link.id)).state).not.toBe('paid')
    expect(await viewOf(folioId, link.id)).toMatchObject({ label: 'unapplied' })
    expect((await detail(folioId)).devolada_attention).toBe(true)
    expect((await counts(org.adminEmail)).devolada_attention).toBe(1)

    const payment = await storedPayment(paymentId)
    const returned = await call(org.adminEmail, 'POST', `/devolada/payments/${payment.id}/resolve`, { action: 'returned' })
    expect(returned.status, returned.text).toBe(200)
    expect((await detail(folioId)).devolada_attention).toBe(false)
  })
})

describe('Devolada down during the close (D12 step 3)', () => {
  it('the link stays `closing`, and a later sweep closes it', async () => {
    const folioId = await apartado('cash')
    const link = await settlementLink(folioId)
    fake.down()
    expect((await call(org.agentEmail, 'POST', `/pos/folios/${folioId}/cancel`, {})).status).toBe(200)
    await vi.waitFor(() => expect(fake.callsTo('closePaymentLink').length).toBeGreaterThan(0))
    expect((await linkById(link.id)).state).toBe('closing')

    fake.up()
    await sweepDevoladaPayments(env, new Date())
    expect(await linkById(link.id)).toMatchObject({ state: 'closed', closed_reason: 'cancelled' })
  })

  it('a `LINK_CLOSED` answer counts as closed', async () => {
    const folioId = await apartado('cash')
    const link = await settlementLink(folioId)
    fake.failNext('closePaymentLink', 'link_closed')
    expect((await call(org.agentEmail, 'POST', `/pos/folios/${folioId}/cancel`, {})).status).toBe(200)
    await vi.waitFor(async () => expect((await linkById(link.id)).state).toBe('closed'))
  })
})

describe('isolation (constitution III)', () => {
  it("another organization can neither cancel this sale nor close its links, and this sale's writes close only its own", async () => {
    const { orgB } = await seedTwoOrgs()
    const { folioId, first } = await twoLines()
    const link = await settlementLink(folioId)
    expect((await call(orgB.adminEmail, 'POST', `/folios/${folioId}/cancel`, {})).status).toBe(404)
    expect((await cancelLine(folioId, first, 'admin', orgB.adminEmail)).status).toBe(404)
    expect((await call(orgB.adminEmail, 'POST', `/pos/folios/${folioId}/reject`, {})).status).toBe(404)
    expect(await linkById(link.id)).toMatchObject({ state: 'open', closed_reason: null })

    // A row of another organization on the same sale id — impossible through the API — stays open:
    // every closing statement is scoped by the writer's own organization.
    const foreign = await insertLink({
      organizationId: orgB.organizationId,
      folioId,
      credentialId: await currentCredentialId(org.organizationId),
      requestedBy: orgB.adminUserId,
      state: 'open',
      kind: 'sale',
    })
    expect((await call(org.agentEmail, 'POST', `/pos/folios/${folioId}/cancel`, {})).status).toBe(200)
    expect(await linkById(link.id)).toMatchObject({ closed_reason: 'cancelled' })
    expect(await linkById(foreign)).toMatchObject({ state: 'open', closed_reason: null })
  })
})
