// devolada-transfer-verification US1 — the server decides each payment link's label, in the
// precedence order of contracts/turistear-api.md § Labels, and reads a sale's links newest first
// with their current payment (research D14).
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { deriveLinkLabel, loadPaymentLinkViews } from '../../src/utils/devoladaLinkView'
import {
  clearDevoladaDb,
  insertLink,
  insertPayment,
  seedSellers,
  sellByTransfer,
} from '../helpers/devoladaFixtures'

type State = Parameters<typeof deriveLinkLabel>[0]['state']
type Status = NonNullable<Parameters<typeof deriveLinkLabel>[1]>['status']

const link = (state: State) => ({ state })
const pay = (status: Status, awaiting: 'payer_tracking_key' | null = null) => ({ status, awaiting })

describe('deriveLinkLabel — one case per row of § Labels, first match wins', () => {
  it.each([
    ['link_failed', link('failed'), null, false],
    ['link_failed', link('abandoned'), null, false],
    ['link_failed', link('creating'), null, false],
    // A failed link wins over the payment it last saw (D21: no key can read it any more).
    ['link_failed', link('failed'), pay('validating'), false],
    ['confirmed', link('paid'), pay('confirmed'), false],
    ['unapplied', link('closed'), pay('unapplied'), false],
    // A cancelled sale is never verified: its confirmed money is money to return.
    ['unapplied', link('closed'), pay('confirmed'), true],
    // devolada-transfer-verification US4 — so is confirmed money on a link a write closed first (D13):
    // a cash settlement, or a line cancellation that changed the balance.
    ['unapplied', { state: 'closed', closedReason: 'settled_otherwise' }, pay('confirmed'), false],
    ['unapplied', { state: 'closing', closedReason: 'amount_changed' }, pay('confirmed'), false],
    // A link the admin's Verificar closed ends `paid` when its money arrives: that money is the sale's.
    ['confirmed', { state: 'paid', closedReason: 'verified_by_admin' }, pay('confirmed'), false],
    ['partial', link('open'), pay('partial'), false],
    ['invalid', link('open'), pay('invalid'), false],
    ['not_received', link('open'), pay('expired'), false],
    ['not_received', link('expired'), null, false],
    ['closed', link('closing'), null, false],
    ['closed', link('closed'), null, false],
    ['credit_paused', link('open'), pay('queued_for_credit'), false],
    ['needs_tracking_key', link('open'), pay('validating', 'payer_tracking_key'), false],
    ['validating', link('open'), pay('validating'), false],
    // A payment in flight on a link already closing is still being verified.
    ['validating', link('closing'), pay('validating'), false],
    ['awaiting_payment', link('open'), null, false],
  ] as const)('%s', (expected, l, p, cancelled) => {
    expect(deriveLinkLabel(l, p, cancelled)).toBe(expected)
  })
})

describe('loadPaymentLinkViews', () => {
  beforeEach(clearDevoladaDb)

  it("orders a sale's links newest first, each with its latest non-superseded payment", async () => {
    const org = await seedSellers('views')
    const sale = await sellByTransfer(org.agentEmail, org.slotId, { payment_reference: 'REF-1234' })
    const folioId = sale.json.folio.id as string
    await env.DB.prepare(
      `INSERT INTO devolada_credentials (id, organization_id, mode, ciphertext, iv, key_hint, created_by, created_at)
       VALUES ('cred-1', ?, 'test', 'x', 'y', 'abcd', ?, 0)`,
    )
      .bind(org.organizationId, org.adminId)
      .run()
    const base = Math.floor(Date.now() / 1000)
    const older = await insertLink({
      organizationId: org.organizationId,
      folioId,
      credentialId: 'cred-1',
      requestedBy: org.agentId,
      state: 'expired',
      createdAt: base - 3600,
    })
    const newer = await insertLink({
      organizationId: org.organizationId,
      folioId,
      credentialId: 'cred-1',
      requestedBy: org.agentId,
      state: 'open',
      createdAt: base,
    })
    // On the newer link: an early payment, then a correction that superseded a later one.
    await insertPayment({ organizationId: org.organizationId, linkId: newer, folioId, status: 'invalid', createdAt: base + 10 })
    const current = await insertPayment({
      organizationId: org.organizationId,
      linkId: newer,
      folioId,
      status: 'validating',
      createdAt: base + 20,
    })
    await insertPayment({ organizationId: org.organizationId, linkId: newer, folioId, status: 'superseded', createdAt: base + 30 })

    const views = (await loadPaymentLinkViews(getDb(env), org.organizationId, { folioIds: [folioId] })).get(folioId)!
    expect(views.map((v) => v.id)).toEqual([newer, older])
    expect(views[0]).toMatchObject({ label: 'validating', payment: { id: current, status: 'validating' } })
    expect(views[1]).toMatchObject({ label: 'not_received', payment: null })

    // Another organization's id reads nothing.
    const other = await seedSellers('views-other')
    const foreign = await loadPaymentLinkViews(getDb(env), other.organizationId, { folioIds: [folioId] })
    expect(foreign.size).toBe(0)
  })
})
