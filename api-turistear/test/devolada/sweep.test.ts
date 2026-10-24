// devolada-transfer-verification US1, US2 — the recovery sweep follows every open link to its
// verdict when a notification never arrives, each with the key that created it, within Devolada's
// budget, fail-soft per organization (FR-004, FR-012, SC-003; research D12, D17, D19, D21). Past a
// link's expiry, and only after a successful re-read, it cancels a sale whose money never arrived
// (FR-016, SC-009; research D9, D11), and it closes at Devolada the links a sale stopped taking
// (research D12 step 3, D13).
// Dates are frozen in tests (apply-migrations.ts), so the sweep is called with an explicit `now`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { sweepDevoladaPayments } from '../../src/routes/devolada/sweep'
import { stubResend } from '../helpers/auth-flows'
import { installFakeDevolada, type FakeDevolada } from '../helpers/devolada'
import {
  call,
  clearDevoladaDb,
  connectToFake,
  connectionRow,
  credentialRows,
  currentCredentialId,
  folioRow,
  insertBareFolio,
  insertLink,
  insertPayment,
  linkRows,
  seedSellers,
  sellByTransfer,
  type SeededSellers,
} from '../helpers/devoladaFixtures'

const NOW = new Date('2026-06-14T12:00:00Z')
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000)
const sec = (d: Date) => Math.floor(d.getTime() / 1000)

let fake: FakeDevolada
let org: SeededSellers

beforeEach(async () => {
  await clearDevoladaDb()
  stubResend()
  fake = await installFakeDevolada()
  org = await seedSellers('sweep')
})
afterEach(() => vi.restoreAllMocks())

const sale = async (o: SeededSellers = org) => {
  const res = await sellByTransfer(o.agentEmail, o.slotId)
  expect(res.status, res.text).toBe(201)
  const [link] = await linkRows(res.json.folio.id)
  return { folioId: res.json.folio.id as string, link }
}

const linkById = (id: string) => env.DB.prepare(`SELECT * FROM devolada_links WHERE id = ?`).bind(id).first<any>()
const listCallsFor = (apiKey: string) => fake.callsTo('listPayments').filter((c) => c.apiKey === apiKey)

describe('recovery (D12, SC-003)', () => {
  it('a confirmed payment whose notification never arrived is applied by the sweep', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId, link } = await sale()
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    const r = await sweepDevoladaPayments(env, NOW)
    expect(r).toMatchObject({ checked: 1, applied: 1, failed: 0 })
    expect(await folioRow(folioId)).toMatchObject({ payment_verification: 'verified', payment_verified_by: null })
    expect((await linkById(link.id)).state).toBe('paid')
    const detail = (await call(org.adminEmail, 'GET', `/folios/${folioId}`)).json.folio
    expect(detail.lines[0].qr_token).toBeTruthy()
  })

  it('a never-checked link is re-read on the first run; one checked under 10 minutes ago is skipped, over 10 re-read', async () => {
    const business = await connectToFake(fake, org.adminEmail)
    const { link } = await sale()
    await sweepDevoladaPayments(env, NOW)
    expect(listCallsFor(business.apiKey)).toHaveLength(1)
    expect((await linkById(link.id)).last_checked_at).toBe(sec(NOW))

    await sweepDevoladaPayments(env, at(9))
    expect(listCallsFor(business.apiKey)).toHaveLength(1)
    await sweepDevoladaPayments(env, at(11))
    expect(listCallsFor(business.apiKey)).toHaveLength(2)
  })

  it("a disconnected organization's open link is still followed (FR-004)", async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId, link } = await sale()
    await call(org.adminEmail, 'DELETE', '/organizations/me/devolada')
    const paymentId = fake.submitProof(link.devolada_link_id)
    fake.advance(paymentId, 'confirmed')
    await sweepDevoladaPayments(env, NOW)
    expect((await folioRow(folioId)).payment_verification).toBe('verified')
  })

  it('a link is checked with the key that created it, after a switch to another business (D21)', async () => {
    const first = await connectToFake(fake, org.adminEmail)
    const { link } = await sale()
    const second = await connectToFake(fake, org.adminEmail)
    await sweepDevoladaPayments(env, NOW)
    expect(listCallsFor(first.apiKey)).toHaveLength(1)
    expect(listCallsFor(second.apiKey)).toHaveLength(0)
    expect((await linkById(link.id)).last_checked_at).toBe(sec(NOW))
  })
})

describe('budget and order (D12)', () => {
  it('with 60 links due, a run checks 50 — past expiry first, then never checked, then the oldest — and the next run the other 10', async () => {
    const business = await connectToFake(fake, org.adminEmail)
    const credentialId = await currentCredentialId(org.organizationId)
    const place = async (opts: { expiresAt?: number; lastCheckedAt?: number | null }) => {
      const folioId = await insertBareFolio(org.organizationId, org.agentId)
      return insertLink({
        organizationId: org.organizationId,
        folioId,
        credentialId,
        requestedBy: org.agentId,
        state: 'open',
        devoladaLinkId: `lnk_${crypto.randomUUID()}`,
        expiresAt: opts.expiresAt ?? sec(at(600)),
        lastCheckedAt: opts.lastCheckedAt ?? null,
      })
    }
    const pastExpiry: string[] = []
    const neverChecked: string[] = []
    const checked: string[] = []
    for (let i = 0; i < 10; i += 1) pastExpiry.push(await place({ expiresAt: sec(at(-5)), lastCheckedAt: sec(at(-3)) }))
    for (let i = 0; i < 20; i += 1) neverChecked.push(await place({}))
    // Checked 30..59 minutes ago: the oldest twenty make the first run.
    for (let i = 0; i < 30; i += 1) checked.push(await place({ lastCheckedAt: sec(at(-30 - i)) }))

    const first = await sweepDevoladaPayments(env, NOW)
    expect(first.checked).toBe(50)
    expect(listCallsFor(business.apiKey)).toHaveLength(50)
    for (const id of pastExpiry) expect((await linkById(id)).state).toBe('expired')
    for (const id of neverChecked) expect((await linkById(id)).last_checked_at).toBe(sec(NOW))
    const oldest = checked.slice(10)
    for (const id of oldest) expect((await linkById(id)).last_checked_at).toBe(sec(NOW))
    for (const id of checked.slice(0, 10)) expect((await linkById(id)).last_checked_at).not.toBe(sec(NOW))

    const second = await sweepDevoladaPayments(env, NOW)
    expect(second.checked).toBe(10)
    expect(listCallsFor(business.apiKey)).toHaveLength(60)
  })

  it('RATE_LIMITED stops only that organization', async () => {
    await connectToFake(fake, org.adminEmail)
    await sale()
    await sale()
    const other = await seedSellers('sweep-other')
    const otherBusiness = await connectToFake(fake, other.adminEmail)
    const { link: otherLink } = await sale(other)
    // The other organization's link was checked long ago: this organization's go first.
    await env.DB.prepare(`UPDATE devolada_links SET last_checked_at = ? WHERE id = ?`)
      .bind(sec(at(-60)), otherLink.id)
      .run()
    fake.failNext('listPayments', 'rate_limited')
    await sweepDevoladaPayments(env, NOW)
    const own = fake.callsTo('listPayments').filter((c) => c.apiKey !== otherBusiness.apiKey)
    expect(own).toHaveLength(1)
    expect(listCallsFor(otherBusiness.apiKey)).toHaveLength(1)
    expect((await linkById(otherLink.id)).last_checked_at).toBe(sec(NOW))
  })

  it("one organization failing does not stop another, a credential unreadable here included (D17)", async () => {
    await connectToFake(fake, org.adminEmail)
    const { link } = await sale()
    const other = await seedSellers('sweep-other')
    const otherBusiness = await connectToFake(fake, other.adminEmail)
    const { link: otherLink } = await sale(other)
    await env.DB.prepare(`UPDATE devolada_links SET last_checked_at = ? WHERE id = ?`)
      .bind(sec(at(-60)), otherLink.id)
      .run()
    // This organization's key was sealed under another secret: it cannot be read here.
    await env.DB.prepare(`UPDATE devolada_credentials SET ciphertext = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE organization_id = ?`)
      .bind(org.organizationId)
      .run()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await sweepDevoladaPayments(env, NOW)
    expect(r.failed).toBeGreaterThan(0)
    expect(errors).toHaveBeenCalled()
    expect((await linkById(link.id)).last_checked_at).toBeNull()
    expect(listCallsFor(otherBusiness.apiKey)).toHaveLength(1)
  })
})

describe('credentials (D21)', () => {
  it('a retired key with no unresolved link is erased; one with an unresolved link is kept, a closed link with a payment in flight included', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId, link } = await sale()
    await connectToFake(fake, org.adminEmail) // the first key is retired, with an open link
    const [firstCredential] = await credentialRows(org.organizationId)

    await sweepDevoladaPayments(env, NOW)
    expect((await credentialRows(org.organizationId))[0]).toMatchObject({ erased_at: null })
    expect((await credentialRows(org.organizationId))[0].ciphertext).toBeTruthy()

    // A closed link whose payment is still in flight keeps it too.
    await env.DB.prepare(`UPDATE devolada_links SET state = 'closed' WHERE id = ?`).bind(link.id).run()
    await insertPayment({ organizationId: org.organizationId, linkId: link.id, folioId, status: 'validating' })
    await sweepDevoladaPayments(env, at(1))
    expect((await credentialRows(org.organizationId))[0].ciphertext).toBeTruthy()

    // Once its payment is final, nothing it serves is unresolved: erased, the row kept for audit.
    await env.DB.prepare(`UPDATE devolada_payments SET status = 'unapplied' WHERE link_id = ?`).bind(link.id).run()
    await sweepDevoladaPayments(env, at(2))
    const [erased] = await credentialRows(org.organizationId)
    expect(erased.id).toBe(firstCredential.id)
    expect(erased).toMatchObject({ ciphertext: null, iv: null, erased_at: sec(at(2)) })
  })

  it("a disconnected organization's key is erased once it has no unresolved link", async () => {
    await connectToFake(fake, org.adminEmail)
    await call(org.adminEmail, 'DELETE', '/organizations/me/devolada')
    await sweepDevoladaPayments(env, NOW)
    const [credential] = await credentialRows(org.organizationId)
    expect(credential).toMatchObject({ ciphertext: null, erased_at: sec(NOW) })
  })

  it('a rejected retired key: the link moves to the current key when it can read it, otherwise it fails and goes to the admin, never cancelled', async () => {
    const first = await connectToFake(fake, org.adminEmail)
    const { folioId: rotatedSale, link: rotatedLink } = await sale()
    // A rotation within the same business: the new key can read the old key's links.
    const rotatedKey = fake.addKey(first.businessId)
    const res = await call(org.adminEmail, 'PUT', '/organizations/me/devolada', { api_key: rotatedKey })
    expect(res.status).toBe(200)
    fake.revokeKey(first.apiKey)
    await sweepDevoladaPayments(env, NOW)
    expect((await linkById(rotatedLink.id)).credential_id).toBe(await currentCredentialId(org.organizationId))
    expect((await folioRow(rotatedSale)).cancelled_at).toBeNull()

    // A switch to another business, whose key cannot read the link: it fails, for the admin.
    const { folioId, link } = await sale()
    await connectToFake(fake, org.adminEmail)
    fake.revokeKey(rotatedKey)
    await sweepDevoladaPayments(env, at(11))
    expect((await linkById(link.id)).state).toBe('failed')
    expect(await folioRow(folioId)).toMatchObject({ payment_verification: 'pending', cancelled_at: null })
    const row = (await call(org.adminEmail, 'GET', '/folios')).json.folios.find((f: any) => f.id === folioId)
    expect(row.payment_link.label).toBe('link_failed')
    expect(row.verification_auto).toBe(false)
  })

  it("a rejected current key breaks the connection and changes no link; a retired key's links are still checked in the run", async () => {
    const previous = await connectToFake(fake, org.adminEmail)
    const { link: retiredLink } = await sale()
    const current = await connectToFake(fake, org.adminEmail)
    const { link: currentLink } = await sale()
    fake.revokeKey(current.apiKey)
    await sweepDevoladaPayments(env, NOW)
    expect(await connectionRow(org.organizationId)).toMatchObject({
      status: 'broken',
      broken_reason: 'DEVOLADA_CREDENTIAL_REJECTED',
    })
    expect(await linkById(currentLink.id)).toMatchObject({ state: 'open', last_checked_at: null })
    expect(listCallsFor(previous.apiKey)).toHaveLength(1)
    expect((await linkById(retiredLink.id)).last_checked_at).toBe(sec(NOW))
  })

  it("a retired key's suspended business changes nothing: retried at the next run, the connection untouched", async () => {
    const previous = await connectToFake(fake, org.adminEmail)
    const { link } = await sale()
    await connectToFake(fake, org.adminEmail)
    fake.suspend(previous.businessId)
    await sweepDevoladaPayments(env, NOW)
    expect((await connectionRow(org.organizationId)).status).toBe('connected')
    expect(await linkById(link.id)).toMatchObject({ state: 'open', last_checked_at: null })

    fake.suspend(previous.businessId, false)
    await sweepDevoladaPayments(env, at(15))
    expect((await linkById(link.id)).last_checked_at).toBe(sec(at(15)))
  })
})

describe('links in other states (D12, D19)', () => {
  it('a link left creating for more than 5 minutes becomes abandoned; a younger one is left alone', async () => {
    await connectToFake(fake, org.adminEmail)
    // Devolada is down: the abandoned link's replay (US4, below) cannot run this time.
    fake.failNext('createPaymentLink', 'unreachable')
    const credentialId = await currentCredentialId(org.organizationId)
    const stale = await insertLink({
      organizationId: org.organizationId,
      folioId: await insertBareFolio(org.organizationId, org.agentId),
      credentialId,
      requestedBy: org.agentId,
      state: 'creating',
      createdAt: sec(at(-6)),
    })
    const young = await insertLink({
      organizationId: org.organizationId,
      folioId: await insertBareFolio(org.organizationId, org.agentId),
      credentialId,
      requestedBy: org.agentId,
      state: 'creating',
      createdAt: sec(at(-1)),
    })
    await sweepDevoladaPayments(env, NOW)
    expect((await linkById(stale)).state).toBe('abandoned')
    expect((await linkById(young)).state).toBe('creating')
  })

  it('a link whose payment expired at Devolada cancels its sale; one with a payment in flight stays open', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId: expiredSale, link: expiredOne } = await sale()
    const { folioId: inFlightSale, link: inFlight } = await sale()
    fake.advance(fake.submitProof(expiredOne.devolada_link_id), 'expired')
    fake.submitProof(inFlight.devolada_link_id)
    await sweepDevoladaPayments(env, new Date((expiredOne.expires_at + 60) * 1000))
    expect((await linkById(expiredOne.id)).state).toBe('expired')
    expect((await folioRow(expiredSale)).cancellation_source).toBe('payment_not_received')
    expect((await linkById(inFlight.id)).state).toBe('open')
    expect((await folioRow(inFlightSale)).cancelled_at).toBeNull()
  })
})

describe('money that never arrived (D9, D11, FR-016, SC-009)', () => {
  const booked = async (slotId: string) =>
    (await env.DB.prepare(`SELECT booked FROM slots WHERE id = ?`).bind(slotId).first<any>()).booked as number

  it('an unpaid link past its expiry cancels its sale only after a successful re-read, and its seats are back after one run', async () => {
    const business = await connectToFake(fake, org.adminEmail)
    const { folioId, link } = await sale()
    const past = new Date((link.expires_at + 60) * 1000)
    expect(await booked(org.slotId)).toBe(1)

    // A failing re-read cancels nothing: the sweep never cancels on the clock alone.
    fake.failNext('listPayments', '500')
    await sweepDevoladaPayments(env, past)
    expect((await linkById(link.id)).state).toBe('open')
    expect((await folioRow(folioId)).cancelled_at).toBeNull()
    expect(await booked(org.slotId)).toBe(1)

    await sweepDevoladaPayments(env, new Date(past.getTime() + 60_000))
    expect(await folioRow(folioId)).toMatchObject({
      cancellation_source: 'payment_not_received',
      cancellation_reason: 'No se recibió la transferencia',
      cancelled_by: null,
    })
    expect((await linkById(link.id)).state).toBe('expired')
    expect(await booked(org.slotId)).toBe(0)
    const row = (await call(org.adminEmail, 'GET', '/folios')).json.folios.find((f: any) => f.id === folioId)
    expect(row.payment_link.label).toBe('not_received')

    const calls = listCallsFor(business.apiKey).length
    await sweepDevoladaPayments(env, new Date(past.getTime() + 30 * 60_000))
    expect(listCallsFor(business.apiKey)).toHaveLength(calls)
    expect(await booked(org.slotId)).toBe(0)
  })

  it('a payment validating at the expiry keeps the sale and the link open', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId, link } = await sale()
    fake.submitProof(link.devolada_link_id)
    await sweepDevoladaPayments(env, new Date((link.expires_at + 60) * 1000))
    expect((await linkById(link.id)).state).toBe('open')
    expect((await folioRow(folioId)).cancelled_at).toBeNull()
  })

  it('a payment that ended partial or invalid cancels nothing at the expiry: the link expires, the admin decides, and it is not re-read again', async () => {
    const business = await connectToFake(fake, org.adminEmail)
    const { folioId: partialSale, link: partialLink } = await sale()
    const { folioId: invalidSale, link: invalidLink } = await sale()
    fake.advance(fake.submitProof(partialLink.devolada_link_id), 'partial', 100000)
    fake.advance(fake.submitProof(invalidLink.devolada_link_id), 'invalid')
    const past = new Date((partialLink.expires_at + 60) * 1000)
    await sweepDevoladaPayments(env, past)
    for (const [folioId, link, label] of [
      [partialSale, partialLink, 'partial'],
      [invalidSale, invalidLink, 'invalid'],
    ] as const) {
      expect((await linkById(link.id)).state).toBe('expired')
      expect(await folioRow(folioId)).toMatchObject({ cancelled_at: null, payment_verification: 'pending' })
      const row = (await call(org.adminEmail, 'GET', '/folios')).json.folios.find((f: any) => f.id === folioId)
      expect(row.payment_link.label).toBe(label)
      expect(row.verification_auto).toBe(false)
    }
    const calls = listCallsFor(business.apiKey).length
    await sweepDevoladaPayments(env, new Date(past.getTime() + 30 * 60_000))
    expect(listCallsFor(business.apiKey)).toHaveLength(calls)
  })
})

describe('closing links (D12 step 3, D13, D21)', () => {
  /** A sale whose link the sale stopped taking: `closing`, with Devolada's id or without it. */
  const closingLink = async (opts: { forgetId?: boolean; createdMinutesAgo?: number } = {}) => {
    const { folioId, link } = await sale()
    await env.DB.prepare(
      `UPDATE devolada_links SET state = 'closing', closed_reason = 'cancelled', devolada_link_id = ?, created_at = ? WHERE id = ?`,
    )
      .bind(
        opts.forgetId ? null : link.devolada_link_id,
        sec(at(-(opts.createdMinutesAgo ?? 0))),
        link.id,
      )
      .run()
    return { folioId, link }
  }

  it('a link left closing because Devolada was down is closed by a later run', async () => {
    await connectToFake(fake, org.adminEmail)
    const { link } = await closingLink()
    fake.down()
    await sweepDevoladaPayments(env, NOW)
    expect((await linkById(link.id)).state).toBe('closing')
    fake.up()
    await sweepDevoladaPayments(env, at(15))
    expect((await linkById(link.id)).state).toBe('closed')
    expect(fake.link(link.devolada_link_id).closedAt).not.toBeNull()
    expect(fake.callsTo('closePaymentLink').at(-1)!.idempotencyKey).toBe(`close:${link.id}`)
  })

  it('LINK_CLOSED counts as closed', async () => {
    await connectToFake(fake, org.adminEmail)
    const { link } = await closingLink()
    fake.failNext('closePaymentLink', 'link_closed')
    await sweepDevoladaPayments(env, NOW)
    expect((await linkById(link.id)).state).toBe('closed')
  })

  it("a closing link whose retired key Devolada rejects moves to the current key, or fails when no key can read it", async () => {
    const first = await connectToFake(fake, org.adminEmail)
    const { link: rotated } = await closingLink()
    // A rotation within the same business: the new key can read the old key's link.
    const rotatedKey = fake.addKey(first.businessId)
    expect((await call(org.adminEmail, 'PUT', '/organizations/me/devolada', { api_key: rotatedKey })).status).toBe(200)
    fake.revokeKey(first.apiKey)
    await sweepDevoladaPayments(env, NOW)
    expect(await linkById(rotated.id)).toMatchObject({
      state: 'closing',
      credential_id: await currentCredentialId(org.organizationId),
    })
    await sweepDevoladaPayments(env, at(15))
    expect((await linkById(rotated.id)).state).toBe('closed')

    // A switch to another business, whose key cannot read the link: it fails.
    const { link: lost } = await closingLink()
    await connectToFake(fake, org.adminEmail)
    fake.revokeKey(rotatedKey)
    await sweepDevoladaPayments(env, at(30))
    expect((await linkById(lost.id)).state).toBe('failed')
  })

  it('a closing link whose current key is rejected stays closing, and the connection is broken', async () => {
    const business = await connectToFake(fake, org.adminEmail)
    const { link } = await closingLink()
    fake.revokeKey(business.apiKey)
    await sweepDevoladaPayments(env, NOW)
    expect((await linkById(link.id)).state).toBe('closing')
    expect(await connectionRow(org.organizationId)).toMatchObject({
      status: 'broken',
      broken_reason: 'DEVOLADA_CREDENTIAL_REJECTED',
    })
  })

  it('a link marked closing while its create was still running is closed once the create stored its id', async () => {
    await connectToFake(fake, org.adminEmail)
    // The create's outcome stored Devolada's id after the cancellation marked the row: closed.
    const { link } = await closingLink({ createdMinutesAgo: 1 })
    await sweepDevoladaPayments(env, NOW)
    expect((await linkById(link.id)).state).toBe('closed')
  })

  it('one whose create never recorded an id is first replayed with the same key, once that create is surely over', async () => {
    await connectToFake(fake, org.adminEmail)
    const young = await closingLink({ forgetId: true, createdMinutesAgo: 1 })
    const old = await closingLink({ forgetId: true, createdMinutesAgo: 6 })
    const createsBefore = fake.callsTo('createPaymentLink').length
    await sweepDevoladaPayments(env, NOW)

    // Still running, perhaps: left alone.
    expect(await linkById(young.link.id)).toMatchObject({ state: 'closing', devolada_link_id: null })
    // Surely over: the same key answers the link Devolada created, which is then closed.
    const replays = fake.callsTo('createPaymentLink').slice(createsBefore)
    expect(replays.map((c) => c.idempotencyKey)).toEqual([old.link.id])
    expect(await linkById(old.link.id)).toMatchObject({
      state: 'closed',
      devolada_link_id: old.link.devolada_link_id,
    })
    expect(fake.link(old.link.devolada_link_id).closedAt).not.toBeNull()
  })
})


// devolada-transfer-verification US4 — the sweep replays abandoned links and follows closed ones
// whose payment is still in flight (D12 steps 1 and 3, FR-012, D21).
describe('abandoned links (D12 step 3, US4)', () => {
  /** A transfer sale whose link create timed out: `abandoned`, with no Devolada id. */
  const abandonedSale = async () => {
    fake.failNext('createPaymentLink', 'timeout')
    const res = await sellByTransfer(org.agentEmail, org.slotId)
    expect(res.status, res.text).toBe(201)
    expect(res.json.payment_link_error).toBe('DEVOLADA_UNAVAILABLE')
    const [link] = await linkRows(res.json.folio.id)
    expect(link).toMatchObject({ state: 'abandoned', devolada_link_id: null })
    return { folioId: res.json.folio.id as string, link }
  }

  it('once its create is surely over, the sweep replays it with the same key and closes the link as `abandoned`', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId, link } = await abandonedSale()
    const createsBefore = fake.callsTo('createPaymentLink').length

    // Still within 5 minutes of the create: left alone.
    await sweepDevoladaPayments(env, at(1))
    expect(fake.callsTo('createPaymentLink')).toHaveLength(createsBefore)

    await sweepDevoladaPayments(env, at(6))
    const [replay] = fake.callsTo('createPaymentLink').slice(createsBefore)
    expect(replay!.idempotencyKey).toBe(link.id)
    const after = await linkById(link.id)
    expect(after).toMatchObject({ state: 'closed', closed_reason: 'abandoned' })
    expect(fake.link(after.devolada_link_id).closedAt).not.toBeNull()
    // The timeline says so, by «Sistema».
    const closed = await env.DB.prepare(
      `SELECT actor_id, payload FROM folio_events WHERE folio_id = ? AND event_type = 'payment_link_closed'`,
    )
      .bind(folioId)
      .all<any>()
    expect(closed.results.map((e) => ({ actor_id: e.actor_id, payload: JSON.parse(e.payload) }))).toEqual([
      { actor_id: null, payload: { link_id: link.id, reason: 'abandoned' } },
    ])
    // The sale stays on the manual path it took: nothing cancelled, still pending for the admin.
    expect(await folioRow(folioId)).toMatchObject({ cancelled_at: null, payment_verification: 'pending' })
  })

  it('a link the sweep moved from `creating` is replayed in the same run', async () => {
    await connectToFake(fake, org.adminEmail)
    const { link } = await sale()
    await env.DB.prepare(`UPDATE devolada_links SET state = 'creating', devolada_link_id = NULL WHERE id = ?`)
      .bind(link.id)
      .run()
    await sweepDevoladaPayments(env, at(6))
    expect(await linkById(link.id)).toMatchObject({ state: 'closed', closed_reason: 'abandoned' })
  })

  it('a refused replay means Devolada never created it: the link is `failed`', async () => {
    await connectToFake(fake, org.adminEmail)
    const { link } = await abandonedSale()
    fake.failNext('createPaymentLink', 'link_closed')
    await sweepDevoladaPayments(env, at(6))
    expect(await linkById(link.id)).toMatchObject({ state: 'failed', devolada_link_id: null })
    expect(fake.callsTo('closePaymentLink')).toHaveLength(0)
  })

  it('a rejected current key keeps it `abandoned` and breaks the connection', async () => {
    const business = await connectToFake(fake, org.adminEmail)
    const { link } = await abandonedSale()
    fake.revokeKey(business.apiKey)
    await sweepDevoladaPayments(env, at(6))
    expect((await linkById(link.id)).state).toBe('abandoned')
    expect(await connectionRow(org.organizationId)).toMatchObject({
      status: 'broken',
      broken_reason: 'DEVOLADA_CREDENTIAL_REJECTED',
    })
  })

  it('a rejected retired key takes D21’s fallback: with no Devolada id, no other key can find it, so it fails', async () => {
    const first = await connectToFake(fake, org.adminEmail)
    const { link } = await abandonedSale()
    await connectToFake(fake, org.adminEmail)
    fake.revokeKey(first.apiKey)
    await sweepDevoladaPayments(env, at(6))
    expect((await linkById(link.id)).state).toBe('failed')
  })
})

describe('closed links whose payment is still in flight (D12 step 1, FR-012, US4)', () => {
  /** A cancelled apartado whose settlement link was closed under a payment Devolada is validating. */
  const closedUnderPayment = async () => {
    const res = await call(org.agentEmail, 'POST', '/pos/folios', {
      customer_name: 'Cliente Test',
      customer_phone: '+52 55 1234 5678',
      payment_method: 'cash',
      down_payment: 45000,
      lines: [{ slot_id: org.slotId, quantity: 1, unit_price: 150000 }],
    })
    const folioId = res.json.folio.id as string
    const settled = await call(org.agentEmail, 'POST', `/pos/folios/${folioId}/settle`, { method: 'transfer' })
    const link = await linkById(settled.json.payment_link.id)
    const paymentId = fake.submitProof(link.devolada_link_id)
    // The `validating` notification arrives; the cancellation closes the link under it.
    await sweepDevoladaPayments(env, NOW)
    expect((await call(org.agentEmail, 'POST', `/pos/folios/${folioId}/cancel`, {})).status).toBe(200)
    await vi.waitFor(async () => expect((await linkById(link.id)).state).toBe('closed'))
    return { folioId, link, paymentId }
  }

  it('its verdict is applied by the sweep when the notification is lost: money to return', async () => {
    await connectToFake(fake, org.adminEmail)
    const { folioId, link, paymentId } = await closedUnderPayment()
    fake.advance(paymentId, 'unapplied')

    // Checked under 10 minutes ago (the sweep above): skipped.
    await sweepDevoladaPayments(env, at(5))
    expect((await env.DB.prepare(`SELECT status FROM devolada_payments WHERE link_id = ?`).bind(link.id).first<any>()).status).toBe('validating')

    await sweepDevoladaPayments(env, at(11))
    const detail = (await call(org.adminEmail, 'GET', `/folios/${folioId}`)).json.folio
    expect(detail.payment_links.find((l: any) => l.id === link.id)).toMatchObject({ label: 'unapplied' })
    expect(detail.devolada_attention).toBe(true)

    // Final now: the sweep stops reading it.
    const reads = fake.callsTo('listPayments').length
    await sweepDevoladaPayments(env, at(30))
    expect(fake.callsTo('listPayments')).toHaveLength(reads)
  })

  it('it is read with its own credential, a retired one included; once its payment is final that key is erased', async () => {
    const first = await connectToFake(fake, org.adminEmail)
    const { link, paymentId } = await closedUnderPayment()
    // A rotation within the business: the first key is retired, kept while the link is unresolved.
    const rotatedKey = fake.addKey(first.businessId)
    expect((await call(org.adminEmail, 'PUT', '/organizations/me/devolada', { api_key: rotatedKey })).status).toBe(200)
    fake.advance(paymentId, 'unapplied')
    await sweepDevoladaPayments(env, at(11))
    expect(listCallsFor(first.apiKey).length).toBeGreaterThan(0)
    expect(listCallsFor(rotatedKey)).toHaveLength(0)
    expect((await env.DB.prepare(`SELECT status FROM devolada_payments WHERE link_id = ?`).bind(link.id).first<any>()).status).toBe('unapplied')
    const retired = (await credentialRows(org.organizationId)).find((c: any) => c.id === link.credential_id)
    expect(retired).toMatchObject({ ciphertext: null, erased_at: sec(at(11)) })
  })

  it('one no key can read any more becomes `failed`, and its retired credential is then erased', async () => {
    const first = await connectToFake(fake, org.adminEmail)
    const { link } = await closedUnderPayment()
    // A switch to another business, whose key cannot read the link; the first key is revoked.
    await connectToFake(fake, org.adminEmail)
    fake.revokeKey(first.apiKey)
    await sweepDevoladaPayments(env, at(11))
    expect((await linkById(link.id)).state).toBe('failed')
    await sweepDevoladaPayments(env, at(12))
    const retired = (await credentialRows(org.organizationId)).find((c: any) => c.id === link.credential_id)
    expect(retired.erased_at).not.toBeNull()
  })
})
