// devolada-transfer-verification US1 — two organizations, each connected to its own Devolada
// business, never see or change each other's sales, links or counts (constitution III; research D4,
// D21). The webhook has no actor: it reaches an organization only through its own link.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedTwoOrgs, type SeededOrg } from '../helpers/tenancy'
import { installFakeDevolada, type FakeDevolada } from '../helpers/devolada'
import {
  call,
  clearDevoladaDb,
  connectToFake,
  counts,
  folioRow,
  linkRows,
  seedService,
  seedSlot,
  sellByTransfer,
} from '../helpers/devoladaFixtures'

let fake: FakeDevolada
let orgA: SeededOrg
let orgB: SeededOrg

beforeEach(async () => {
  await clearDevoladaDb()
  fake = await installFakeDevolada()
  ;({ orgA, orgB } = await seedTwoOrgs())
})
afterEach(() => vi.restoreAllMocks())

/** Each organization connected to its own business, with one sale by transfer from its admin. */
const twoConnectedSales = async () => {
  const sell = async (o: SeededOrg) => {
    await connectToFake(fake, o.adminEmail)
    const slot = await seedSlot(o.organizationId, await seedService(o.organizationId))
    const res = await sellByTransfer(o.adminEmail, slot)
    expect(res.status, res.text).toBe(201)
    const [link] = await linkRows(res.json.folio.id)
    return { folioId: res.json.folio.id as string, link }
  }
  return { a: await sell(orgA), b: await sell(orgB) }
}

describe('Devolada isolation (constitution III)', () => {
  it("a verdict for org A's link changes only org A", async () => {
    const { a, b } = await twoConnectedSales()
    const paymentId = fake.submitProof(a.link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    const res = await SELF.fetch(await fake.signedEvent(paymentId))
    expect(res.status).toBe(200)
    expect((await folioRow(a.folioId)).payment_verification).toBe('verified')
    expect((await folioRow(b.folioId)).payment_verification).toBe('pending')
    const rows = (await env.DB.prepare(`SELECT organization_id FROM devolada_payments`).all<any>()).results
    expect(rows).toEqual([{ organization_id: orgA.organizationId }])
    const events = (await env.DB.prepare(`SELECT organization_id FROM devolada_events`).all<any>()).results
    expect(events).toEqual([{ organization_id: orgA.organizationId }])
  })

  it("org B's admin gets 404 on org A's sale, and never sees its links", async () => {
    const { a } = await twoConnectedSales()
    expect((await call(orgB.adminEmail, 'GET', `/folios/${a.folioId}`)).status).toBe(404)
    expect((await call(orgB.adminEmail, 'GET', `/pos/folios/${a.folioId}`)).status).toBe(404)
    const list = (await call(orgB.adminEmail, 'GET', '/folios')).json.folios
    expect(list.map((f: any) => f.id)).not.toContain(a.folioId)
    for (const row of list) expect(row.payment_link?.id).not.toBe(a.link.id)
  })

  it('counts are computed per organization', async () => {
    const { a } = await twoConnectedSales()
    const paymentId = fake.submitProof(a.link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    await SELF.fetch(await fake.signedEvent(paymentId))
    expect(await counts(orgA.adminEmail)).toMatchObject({ verification: 0, verification_auto: 0 })
    expect(await counts(orgB.adminEmail)).toMatchObject({ verification: 1, verification_auto: 1 })
  })

  it("an event naming org A's link but signed by an unknown key is 401", async () => {
    const { a } = await twoConnectedSales()
    const paymentId = fake.submitProof(a.link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    const res = await SELF.fetch(await fake.signedEvent(paymentId, { wrongKey: true }))
    expect(res.status).toBe(401)
    expect((await folioRow(a.folioId)).payment_verification).toBe('pending')
  })

  it("a payment of org B's business, announced against org A's link, changes nothing", async () => {
    const { a, b } = await twoConnectedSales()
    // Org B's payment, but the event names org A's link: the re-read with org A's key answers
    // NOT_FOUND, because the payment belongs to another business.
    const paymentId = fake.submitProof(b.link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    const forged = await fake.signedRaw(
      JSON.stringify({
        eventId: 'evt_cross',
        type: 'payment.confirmed',
        createdAt: Date.now(),
        data: {
          paymentId,
          paymentLinkId: a.link.devolada_link_id,
          customerRef: a.folioId,
          isTest: true,
        },
      }),
    )
    expect((await SELF.fetch(forged)).status).toBe(200)
    expect((await folioRow(a.folioId)).payment_verification).toBe('pending')
    expect((await folioRow(b.folioId)).payment_verification).toBe('pending')
  })
})
