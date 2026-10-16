// devolada-transfer-verification US2 — anything short of a clean confirmation reaches the right
// person, with the reason: partial and invalid stay in «Por verificar» for the admin's Verificar or
// Rechazar; money that never arrived cancels the sale through a guarded system cancellation; money
// that settled nothing is flagged until the admin marks it returned (FR-014–FR-018, FR-020; research
// D9, D11, D14, D15).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { cancelForUnreceivedTransfer } from '../../src/routes/pos/unreceivedTransfer'
import { stubResend } from '../helpers/auth-flows'
import { installFakeDevolada, type FakeDevolada } from '../helpers/devolada'
import {
  PHONE,
  call,
  clearDevoladaDb,
  connectToFake,
  counts,
  currentCredentialId,
  folioRow,
  insertLink,
  insertPayment,
  linkRows,
  paymentRowsOf,
  posFolio,
  seedSellers,
  sellByTransfer,
  type SeededSellers,
} from '../helpers/devoladaFixtures'

let fake: FakeDevolada
let org: SeededSellers

beforeEach(async () => {
  await clearDevoladaDb()
  stubResend()
  fake = await installFakeDevolada()
  org = await seedSellers('verdict')
})
afterEach(() => vi.restoreAllMocks())

/** A connected organization's full sale by transfer, with its open link. */
const sale = async (o: SeededSellers = org, connect = true) => {
  if (connect) await connectToFake(fake, o.adminEmail)
  const res = await sellByTransfer(o.agentEmail, o.slotId, { customer_email: 'cliente@example.com' })
  expect(res.status, res.text).toBe(201)
  const [link] = await linkRows(res.json.folio.id)
  return { folioId: res.json.folio.id as string, link }
}

/** Devolada's notification for this payment, signed and delivered. */
const notify = async (paymentId: string) => {
  const res = await SELF.fetch(await fake.signedEvent(paymentId))
  expect(res.status).toBe(200)
}

const adminRow = async (folioId: string, email = org.adminEmail) =>
  (await call(email, 'GET', '/folios')).json.folios.find((f: any) => f.id === folioId)

const booked = async (slotId: string) =>
  (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(slotId).first<any>()).booked as number

const ledger = async (folioId: string) =>
  (
    await env.DB.prepare(`SELECT entry_type, amount, method FROM folio_payments WHERE folio_id = ? ORDER BY rowid`)
      .bind(folioId)
      .all<any>()
  ).results

const events = async (folioId: string, type: string) =>
  (
    await env.DB.prepare(`SELECT actor_id, payload FROM folio_events WHERE folio_id = ? AND event_type = ?`)
      .bind(folioId, type)
      .all<any>()
  ).results.map((e) => ({ actor_id: e.actor_id, payload: JSON.parse(e.payload) }))

const linesOf = async (folioId: string) =>
  (
    await env.DB.prepare(`SELECT cancelled_at, cancellation_source FROM folio_lines WHERE folio_id = ?`)
      .bind(folioId)
      .all<any>()
  ).results

const linkById = (id: string) => env.DB.prepare(`SELECT * FROM devolada_links WHERE id = ?`).bind(id).first<any>()

const storedPayment = (devoladaPaymentId: string) =>
  env.DB.prepare(`SELECT * FROM devolada_payments WHERE devolada_payment_id = ?`).bind(devoladaPaymentId).first<any>()

/** «Por verificar», as the badge, the bar and Hoy compute it. */
const porVerificar = (c: Record<string, number>) => c.verification - c.verification_auto + c.devolada_attention

/** An apartado of one seat (deposit 45 000 of 150 000), sold before any connection: no link. */
const apartado = async (payment: Record<string, unknown>) => {
  const res = await call(org.agentEmail, 'POST', '/pos/folios', {
    customer_name: 'Cliente Test',
    customer_phone: PHONE,
    down_payment: 45000,
    lines: [{ slot_id: org.slotId, quantity: 1, unit_price: 150000 }],
    ...payment,
  })
  expect(res.status, res.text).toBe(201)
  return res.json.folio.id as string
}

describe('partial and invalid stay with the admin (FR-018)', () => {
  it('partial: the sale stays pending, labelled with what was asked and what arrived; Verificar verifies it as the admin', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'partial', 100000)
    await notify(paymentId)

    expect(await folioRow(folioId)).toMatchObject({ payment_verification: 'pending', cancelled_at: null })
    const row = await adminRow(folioId)
    expect(row.payment_link).toMatchObject({ label: 'partial', payment: { asked: 150000, received: 100000 } })
    expect(row.verification_auto).toBe(false)
    expect(porVerificar(await counts(org.adminEmail))).toBe(1)
    const [verdict] = await events(folioId, 'payment_verdict')
    expect(verdict).toMatchObject({ actor_id: null, payload: { link_id: link.id, status: 'partial', asked: 150000, received: 100000 } })

    const verified = await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/verify`)
    expect(verified.status).toBe(200)
    expect(await folioRow(folioId)).toMatchObject({ payment_verification: 'verified', payment_verified_by: org.adminId })
  })

  it('invalid: labelled invalid; Rechazar still cancels the sale', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'invalid')
    await notify(paymentId)
    expect((await adminRow(folioId)).payment_link.label).toBe('invalid')
    expect((await folioRow(folioId)).cancelled_at).toBeNull()

    const rejected = await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/reject`, { reason: 'No llegó' })
    expect(rejected.status).toBe(200)
    expect((await folioRow(folioId)).cancelled_at).not.toBeNull()
  })
})

describe('money that never arrived cancels the sale (D11, FR-016)', () => {
  it('an expired payment on a full sale: «Sistema» cancels it, its seats return once, its money and commission reverse', async () => {
    const { folioId, link } = await sale()
    expect(await booked(org.slotId)).toBe(1)
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'expired')
    await notify(paymentId)

    const folio = await folioRow(folioId)
    expect(folio).toMatchObject({
      cancellation_source: 'payment_not_received',
      cancellation_reason: 'No se recibió la transferencia',
      cancelled_by: null,
      cancellation_clawback: 1,
    })
    expect(folio.cancelled_at).not.toBeNull()
    for (const line of await linesOf(folioId)) {
      expect(line).toMatchObject({ cancelled_at: folio.cancelled_at, cancellation_source: 'payment_not_received' })
    }
    expect(await booked(org.slotId)).toBe(0)
    const rows = await ledger(folioId)
    expect(rows).toContainEqual({ entry_type: 'refund', amount: -150000, method: 'transfer' })
    const commission = rows.find((r: any) => r.entry_type === 'commission')
    expect(rows).toContainEqual({ entry_type: 'commission_reversal', amount: -commission.amount, method: 'transfer' })
    expect(await events(folioId, 'transfer_not_received')).toEqual([
      { actor_id: null, payload: { link_id: link.id, kind: 'sale' } },
    ])
    const rejected = await env.DB.prepare(
      `SELECT channel, status FROM notifications WHERE folio_id = ? AND event = 'payment_rejected' ORDER BY channel`,
    )
      .bind(folioId)
      .all<any>()
    expect(rejected.results).toEqual([
      { channel: 'email', status: 'pending' },
      { channel: 'whatsapp', status: 'pending' },
    ])
    expect((await linkById(link.id)).state).toBe('expired')
    // The customer can no longer pay it at Devolada.
    await vi.waitFor(() => expect(fake.callsTo('closePaymentLink')).toHaveLength(1))
    expect(fake.callsTo('closePaymentLink')[0]!.idempotencyKey).toBe(`close:${link.id}`)

    // A second processor finds nothing to claim: nothing is reversed or released twice.
    expect(
      await cancelForUnreceivedTransfer(
        { db: getDb(env), env, waitUntil: () => {} },
        { organizationId: org.organizationId, folioId, linkId: link.id, at: new Date() },
      ),
    ).toBe('noop')
    expect(await booked(org.slotId)).toBe(0)
    expect((await ledger(folioId)).filter((r: any) => r.entry_type === 'refund')).toHaveLength(1)
    expect((await adminRow(folioId)).payment_link.label).toBe('not_received')
  })

  it('a sale holding other money is kept: the link expires, and the sale waits in «Por verificar», labelled not_received', async () => {
    const { folioId, link } = await sale()
    await env.DB.prepare(
      `INSERT INTO folio_payments (id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at)
       VALUES (?, ?, ?, 'payment', 10000, 'cash', 'not_required', ?, ?)`,
    )
      .bind(crypto.randomUUID(), org.organizationId, folioId, org.agentId, Math.floor(Date.now() / 1000))
      .run()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'expired')
    await notify(paymentId)

    expect(await folioRow(folioId)).toMatchObject({ cancelled_at: null, payment_verification: 'pending' })
    expect(await booked(org.slotId)).toBe(1)
    expect((await linkById(link.id)).state).toBe('expired')
    const row = await adminRow(folioId)
    expect(row.payment_link.label).toBe('not_received')
    expect(row.verification_auto).toBe(false)
    expect(porVerificar(await counts(org.adminEmail))).toBe(1)
  })

  it('a sale an admin verified by hand while its payment was in flight is never cancelled', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    await notify(paymentId)
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/verify`)).status).toBe(200)
    fake.advance(paymentId, 'expired')
    await notify(paymentId)
    expect(await folioRow(folioId)).toMatchObject({ cancelled_at: null, payment_verification: 'verified' })
    expect(await booked(org.slotId)).toBe(1)
  })

  it('an already-cancelled sale is not released a second time', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/reject`, {})).status).toBe(200)
    expect(await booked(org.slotId)).toBe(0)
    fake.advance(paymentId, 'expired')
    await notify(paymentId)
    expect(await booked(org.slotId)).toBe(0)
    expect((await folioRow(folioId)).cancellation_source).not.toBe('payment_not_received')
    expect(await events(folioId, 'transfer_not_received')).toEqual([])
  })

  it('a sale cancelled between the check and the batch: the batch writes nothing (constitution V)', async () => {
    const { folioId, link } = await sale()
    const realDb = getDb(env)
    // Another cancellation lands after D11 read the sale and before its batch runs.
    const racing = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver)
        return async (statements: Parameters<typeof realDb.batch>[0]) => {
          await env.DB.prepare(`UPDATE folios SET cancelled_at = ?, cancellation_source = 'admin' WHERE id = ?`)
            .bind(Math.floor(Date.now() / 1000), folioId)
            .run()
          return target.batch(statements)
        }
      },
    })
    const result = await cancelForUnreceivedTransfer(
      { db: racing, env, waitUntil: () => {} },
      { organizationId: org.organizationId, folioId, linkId: link.id, at: new Date() },
    )
    expect(result).toBe('kept')
    expect((await folioRow(folioId)).cancellation_source).toBe('admin')
    expect(await booked(org.slotId)).toBe(1)
    for (const line of await linesOf(folioId)) expect(line.cancelled_at).toBeNull()
    expect((await ledger(folioId)).map((r: any) => r.entry_type)).not.toContain('refund')
    expect(await events(folioId, 'transfer_not_received')).toEqual([])
  })
})

describe('money that settled nothing (D9, D15)', () => {
  it('unapplied: an attention item until the admin marks it returned; another organization gets 404; accept is refused', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/reject`, {})).status).toBe(200)
    fake.advance(paymentId, 'unapplied')
    await notify(paymentId)

    const row = await adminRow(folioId)
    expect(row).toMatchObject({ devolada_attention: true, payment_link: { label: 'unapplied' } })
    const before = await counts(org.adminEmail)
    expect(before).toMatchObject({ verification: 0, devolada_attention: 1 })
    expect(porVerificar(before)).toBe(1)
    const stored = await storedPayment(paymentId)

    const other = await seedSellers('verdict-other')
    expect((await call(other.adminEmail, 'POST', `/devolada/payments/${stored.id}/resolve`, { action: 'returned' })).status).toBe(404)
    const accept = await call(org.adminEmail, 'POST', `/devolada/payments/${stored.id}/resolve`, { action: 'accept' })
    expect(accept.status).toBe(409)
    expect(accept.json.error.code).toBe('DEVOLADA_PAYMENT_NOT_RESOLVABLE')
    expect((await call(org.agentEmail, 'POST', `/devolada/payments/${stored.id}/resolve`, { action: 'returned' })).status).toBe(403)

    const returned = await call(org.adminEmail, 'POST', `/devolada/payments/${stored.id}/resolve`, {
      action: 'returned',
      note: 'Devuelto por SPEI',
    })
    expect(returned.status, returned.text).toBe(200)
    expect(returned.json.folio).toMatchObject({ id: folioId, devolada_attention: false })
    expect(await storedPayment(paymentId)).toMatchObject({ resolution: 'returned', resolved_by: org.adminId })
    expect((await counts(org.adminEmail)).devolada_attention).toBe(0)

    // A double tap writes nothing.
    const again = await call(org.adminEmail, 'POST', `/devolada/payments/${stored.id}/resolve`, { action: 'returned' })
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('DEVOLADA_PAYMENT_NOT_RESOLVABLE')
  })

  it('confirmed on a cancelled sale is treated as unapplied: never verified', async () => {
    const { folioId, link } = await sale()
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/reject`, {})).status).toBe(200)
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    await notify(paymentId)

    const [row] = await paymentRowsOf(folioId)
    expect(row.verification).toBe('pending')
    expect(await adminRow(folioId)).toMatchObject({ devolada_attention: true, payment_link: { label: 'unapplied' } })
    expect((await events(folioId, 'payment_verdict'))[0]).toMatchObject({ payload: { status: 'confirmed' } })
    const stored = await storedPayment(paymentId)
    const returned = await call(org.adminEmail, 'POST', `/devolada/payments/${stored.id}/resolve`, { action: 'returned' })
    expect(returned.status).toBe(200)
  })

  it('returned is refused for a payment with nothing to return', async () => {
    const { link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'partial', 100000)
    await notify(paymentId)
    const stored = await storedPayment(paymentId)
    const res = await call(org.adminEmail, 'POST', `/devolada/payments/${stored.id}/resolve`, { action: 'returned' })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('DEVOLADA_PAYMENT_NOT_RESOLVABLE')
  })

  it('an unknown action or an oversized note is a 400', async () => {
    const res = await call(org.adminEmail, 'POST', `/devolada/payments/x/resolve`, { action: 'refund' })
    expect(res.status).toBe(400)
    const long = await call(org.adminEmail, 'POST', `/devolada/payments/x/resolve`, {
      action: 'returned',
      note: 'x'.repeat(501),
    })
    expect(long.status).toBe(400)
  })
})

describe('other verdicts (D9, FR-020)', () => {
  it('superseded is recorded and ignored; its correction is applied', async () => {
    const { folioId, link } = await sale()
    const misread = fake.submitProof(link.devolada_link_id)
    fake.advance(misread, 'superseded')
    const correction = fake.submitProof(link.devolada_link_id)
    fake.advance(correction, 'confirmed')
    await notify(misread)
    expect((await folioRow(folioId)).payment_verification).toBe('pending')
    await notify(correction)
    expect((await folioRow(folioId)).payment_verification).toBe('verified')
    expect(await storedPayment(misread)).toMatchObject({ status: 'superseded', applied_status: 'superseded' })
    expect(await events(folioId, 'payment_verdict')).toEqual([])
  })

  it('received above the ask is confirmed: the ledger and the total keep the sale amount, received_amount what arrived', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed', 150500)
    await notify(paymentId)
    expect(await folioRow(folioId)).toMatchObject({ payment_verification: 'verified', total: 150000 })
    const [row] = await paymentRowsOf(folioId)
    expect(row).toMatchObject({ amount: 150000, verification: 'verified' })
    expect(await storedPayment(paymentId)).toMatchObject({ received_amount: 150500, match: 'over' })
  })

  it('a tracking-key wait is shown to the seller', async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.setAwaiting(paymentId)
    await notify(paymentId)
    const folio = await posFolio(org.agentEmail, folioId)
    expect(folio.payment_links[0].label).toBe('needs_tracking_key')
  })

  it('every final verdict stamps the connection: Devolada last decided a payment then', async () => {
    const { link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'invalid')
    await notify(paymentId)
    const connection = await env.DB.prepare(`SELECT last_verdict_at FROM devolada_connections WHERE organization_id = ?`)
      .bind(org.organizationId)
      .first<any>()
    expect(connection.last_verdict_at).not.toBeNull()
  })
})

describe('each sale counts once in «Por verificar» (D14)', () => {
  it('a tracking-key wait on a sale link is counted by verification only', async () => {
    const { link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.setAwaiting(paymentId)
    await notify(paymentId)
    expect(await counts(org.adminEmail)).toMatchObject({ verification: 1, verification_auto: 0, devolada_attention: 0 })
  })

  it('a sale with partial or invalid is never verification_auto', async () => {
    const { link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'invalid')
    await notify(paymentId)
    expect(await counts(org.adminEmail)).toMatchObject({ verification: 1, verification_auto: 0, devolada_attention: 0 })
  })

  it("a settlement exception and a settlement payment queued for credit are counted by devolada_attention only", async () => {
    const folioId = await apartado({ payment_method: 'cash' })
    await connectToFake(fake, org.adminEmail)
    const credentialId = await currentCredentialId(org.organizationId)
    const exception = await insertLink({
      organizationId: org.organizationId,
      folioId,
      credentialId,
      requestedBy: org.agentId,
      kind: 'settlement',
      state: 'closed',
      devoladaLinkId: `lnk_${crypto.randomUUID()}`,
      amount: 105000,
    })
    await insertPayment({ organizationId: org.organizationId, linkId: exception, folioId, status: 'partial' })
    expect(await counts(org.adminEmail)).toMatchObject({ verification: 0, verification_auto: 0, devolada_attention: 1 })
    expect((await adminRow(folioId)).devolada_attention).toBe(true)

    await env.DB.prepare(`UPDATE devolada_payments SET resolution = 'dismissed' WHERE link_id = ?`).bind(exception).run()
    expect((await counts(org.adminEmail)).devolada_attention).toBe(0)

    const paused = await insertLink({
      organizationId: org.organizationId,
      folioId,
      credentialId,
      requestedBy: org.agentId,
      kind: 'settlement',
      state: 'open',
      devoladaLinkId: `lnk_${crypto.randomUUID()}`,
      amount: 105000,
    })
    await insertPayment({ organizationId: org.organizationId, linkId: paused, folioId, status: 'queued_for_credit' })
    expect(await counts(org.adminEmail)).toMatchObject({ verification: 0, verification_auto: 0, devolada_attention: 1 })
  })

  it('a pending apartado whose deposit link is validating while its settlement link has an exception counts once, never auto', async () => {
    const folioId = await apartado({ payment_method: 'transfer', payment_reference: 'SPEI 0001' })
    await connectToFake(fake, org.adminEmail)
    const credentialId = await currentCredentialId(org.organizationId)
    const [deposit] = await paymentRowsOf(folioId)
    const depositLink = await insertLink({
      organizationId: org.organizationId,
      folioId,
      credentialId,
      requestedBy: org.agentId,
      kind: 'deposit',
      state: 'open',
      folioPaymentId: deposit.id,
      devoladaLinkId: `lnk_${crypto.randomUUID()}`,
      amount: 45000,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    await insertPayment({ organizationId: org.organizationId, linkId: depositLink, folioId, status: 'validating' })
    // Devolada is resolving it with nothing for the admin to do — until the settlement's exception.
    expect(await counts(org.adminEmail)).toMatchObject({ verification: 1, verification_auto: 1, devolada_attention: 0 })

    const settlement = await insertLink({
      organizationId: org.organizationId,
      folioId,
      credentialId,
      requestedBy: org.agentId,
      kind: 'settlement',
      state: 'closed',
      devoladaLinkId: `lnk_${crypto.randomUUID()}`,
      amount: 105000,
    })
    await insertPayment({ organizationId: org.organizationId, linkId: settlement, folioId, status: 'invalid' })
    const c = await counts(org.adminEmail)
    expect(c).toMatchObject({ verification: 1, verification_auto: 0, devolada_attention: 0 })
    expect(porVerificar(c)).toBe(1)
    expect(await adminRow(folioId)).toMatchObject({ verification_auto: false, devolada_attention: true })
  })

  it("another organization's attention items are not counted (constitution III)", async () => {
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    expect((await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/reject`, {})).status).toBe(200)
    fake.advance(paymentId, 'unapplied')
    await notify(paymentId)
    const other = await seedSellers('verdict-other')
    expect((await counts(other.adminEmail)).devolada_attention).toBe(0)
    expect(await adminRow(folioId, other.adminEmail)).toBeUndefined()
  })
})
