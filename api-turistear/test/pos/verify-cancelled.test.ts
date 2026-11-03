// bug: verify-cancelled-sale — Verificar never verifies a cancelled sale. Rechazar and the apartado
// sweep leave the transfer `pending` (research defect 5); Verificar on such a sale answers 409 and
// changes nothing: no row flips, no `payment_verified` event, no message to the customer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { sweepExpiredBookings } from '../../src/routes/pos/sweep'
import { stubResend } from '../helpers/auth-flows'
import { seedTwoOrgs } from '../helpers/tenancy'
import { PHONE, call, clearDevoladaDb, seedSellers, type SeededSellers } from '../helpers/devoladaFixtures'

let org: SeededSellers

beforeEach(async () => {
  await clearDevoladaDb()
  stubResend()
  org = await seedSellers('verify')
})
afterEach(() => vi.restoreAllMocks())

const nowSec = () => Math.floor(Date.now() / 1000)

const sellByTransfer = async (extra: Record<string, unknown> = {}) => {
  const res = await call(org.agentEmail, 'POST', '/pos/folios', {
    customer_name: 'Cliente Test',
    customer_phone: PHONE,
    customer_email: 'cliente@example.com',
    payment_method: 'transfer',
    payment_reference: 'SPEI 0001',
    lines: [{ slot_id: org.slotId, quantity: 2, unit_price: 150000 }],
    ...extra,
  })
  expect(res.status, res.text).toBe(201)
  return res.json.folio.id as string
}

const verify = (folioId: string, email = org.adminEmail) => call(email, 'POST', `/pos/folios/${folioId}/verify`, {})

/** What a verification would have changed: the rows, the narrative, the customer's message. */
const verificationTrace = async (folioId: string) => ({
  folio: await env.DB.prepare(`SELECT payment_verification, payment_verified_at, payment_verified_by FROM folios WHERE id = ?`)
    .bind(folioId)
    .first(),
  rows: (
    await env.DB.prepare(
      `SELECT verification, verified_at, verified_by FROM folio_payments
       WHERE folio_id = ? AND entry_type = 'payment' ORDER BY rowid`,
    )
      .bind(folioId)
      .all()
  ).results,
  events: (
    await env.DB.prepare(`SELECT id FROM folio_events WHERE folio_id = ? AND event_type = 'payment_verified'`)
      .bind(folioId)
      .all()
  ).results.length,
  messages: (
    await env.DB.prepare(`SELECT id FROM notifications WHERE folio_id = ? AND event = 'payment_verified'`)
      .bind(folioId)
      .all()
  ).results.length,
})

describe('bug: verify-cancelled-sale — Verificar refuses a cancelled sale', () => {
  it('after Rechazar: 409, and the payment stays as Rechazar left it', async () => {
    const folioId = await sellByTransfer()
    const rejected = await call(org.adminEmail, 'POST', `/pos/folios/${folioId}/reject`, { reason: 'No llegó' })
    expect(rejected.status, rejected.text).toBe(200)
    const before = await verificationTrace(folioId)
    expect(before.rows).toEqual([expect.objectContaining({ verification: 'pending' })])

    const res = await verify(folioId)
    expect(res.status, res.text).toBe(409)
    expect(res.json.error.code).toBe('NOT_PENDING_VERIFICATION')
    expect(await verificationTrace(folioId)).toEqual(before)
    expect(before.events).toBe(0)
    expect(before.messages).toBe(0)
  })

  it('after the sweep released an apartado whose transfer deposit nobody verified: 409', async () => {
    const folioId = await sellByTransfer({ down_payment: 45000 })
    // Past the grace instant (the cancel-unverified-guard pattern): the line departs now, and its
    // hold's clock already passed.
    const now = new Date()
    await env.DB.prepare(`UPDATE folio_lines SET slot_date = ?, slot_start_time = ?, booking_expires_at = ? WHERE folio_id = ?`)
      .bind(now.toISOString().slice(0, 10), now.toISOString().slice(11, 16), nowSec() - 60, folioId)
      .run()
    await env.DB.prepare(`UPDATE folios SET booking_expires_at = ? WHERE id = ?`).bind(nowSec() - 60, folioId).run()
    expect(await sweepExpiredBookings(env)).toMatchObject({ cancelled: 1, failed: 0 })
    const before = await verificationTrace(folioId)

    const res = await verify(folioId)
    expect(res.status, res.text).toBe(409)
    expect(await verificationTrace(folioId)).toEqual(before)
  })

  it('a live sale is still verified, once', async () => {
    const folioId = await sellByTransfer()
    expect((await verify(folioId)).status).toBe(200)
    const after = await verificationTrace(folioId)
    expect(after.folio).toMatchObject({ payment_verification: 'verified' })
    expect(after.events).toBe(1)

    const again = await verify(folioId)
    expect(again.status).toBe(409)
    expect((await verificationTrace(folioId)).events).toBe(1)
  })

  it("another organization's admin gets 404 and the sale is untouched (constitution III)", async () => {
    const folioId = await sellByTransfer()
    const { orgB } = await seedTwoOrgs()
    const before = await verificationTrace(folioId)

    expect((await verify(folioId, orgB.adminEmail)).status).toBe(404)
    expect(await verificationTrace(folioId)).toEqual(before)
  })
})
