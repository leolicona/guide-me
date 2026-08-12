import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { materializeSeededFolio, seedUser, seedTwoOrgs, clearAffiliateDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A85 — the wasted seat, end to end.
// Spec: docs/folios/folio-state-machine.spec.md — S-4 … S-10, S-18.
//
// The pure arithmetic is asserted exhaustively in `folio-fulfillment.unit.test.ts`. What is worth
// asserting HERE is what the unit tests cannot reach: that the reading survives the round trip
// through the API with the ORGANIZATION's clock and margin attached, that the axis is refused from
// a request body, and that one org's wasted seats never appear in another's report.

const ADMIN = 'admin@empresa.com'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const FOLIOS = 'http://api.local/api/folios'
const REPORT = 'http://api.local/api/reports/wasted-seats'

const nowSec = () => Math.floor(Date.now() / 1000)
const HOUR = 3600

/** 'YYYY-MM-DD' / 'HH:MM' for an instant, read in UTC — every seeded org is UTC (see below). */
const utcDay = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10)
const utcTime = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 16)

const seedFolio = async (opts: {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  total?: number
}): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at,
        payment_verification)
     VALUES (?, ?, ?, 'Ana Buceo', NULL, NULL, ?, ?, 0, ?, ?, ?, ?, 'verified')`,
  )
    .bind(
      id, opts.organizationId, opts.agentId, opts.status ?? 'paid',
      opts.total ?? 200000, opts.total ?? 200000, opts.total ?? 200000,
      nowSec(), nowSec(),
    )
    .run()
  return id
}

const seedLine = async (opts: {
  organizationId: string
  folioId: string
  serviceName?: string
  departsAt: number
  quantity?: number
  redeemedCount?: number
  lineTotal?: number
  serviceId?: string
}): Promise<string> => {
  const id = crypto.randomUUID()
  const serviceId = opts.serviceId ?? crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price,
       default_capacity, status, created_at, updated_at)
     VALUES (?, ?, ?, '', 100000, 80000, 30, 'active', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(serviceId, opts.organizationId, opts.serviceName ?? 'Tour Isla Mujeres', nowSec(), nowSec())
    .run()
  await env.DB.prepare(
    `INSERT INTO folio_lines
       (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date,
        slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
        qr_token, redeemed_count, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 50000, 50000, 50000, ?, NULL, ?, ?)`,
  )
    .bind(
      id, opts.organizationId, opts.folioId, serviceId,
      opts.serviceName ?? 'Tour Isla Mujeres',
      utcDay(opts.departsAt), utcTime(opts.departsAt),
      opts.quantity ?? 4, opts.lineTotal ?? 200000,
      opts.redeemedCount ?? 0, nowSec(),
    )
    .run()
  await materializeSeededFolio(opts.folioId)
  return id
}

const setMargin = (organizationId: string, minutes: number) =>
  env.DB.prepare(`UPDATE organizations SET no_show_margin_minutes = ? WHERE id = ?`)
    .bind(minutes, organizationId)
    .run()

const getFolios = async (email = ADMIN) => {
  const res = await SELF.fetch(FOLIOS, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

// The full wipe: this suite seeds services and folio_lines, which `clearTenancyDb` does not
// reach — deleting users first then trips their foreign keys.
beforeEach(clearAffiliateDb)

describe('US-A85 — a folio carries its fulfilment', () => {
  it('S-4 — nobody boarded and the departure has passed', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId, departsAt: nowSec() - 3 * HOUR })

    const { json } = await getFolios()
    const row = json.folios.find((f: any) => f.id === folioId)
    expect(row.fulfillment).toBe('no_show')
    // The money axis did not move. A no-show is a reading, not a state change (rule 7).
    expect(row.status).toBe('paid')
  })

  it('S-4 — a departure still ahead is merely pending', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId, departsAt: nowSec() + 3 * HOUR })

    const { json } = await getFolios()
    expect(json.folios.find((f: any) => f.id === folioId).fulfillment).toBe('pending')
  })

  it('S-4c — the ORG\'s margin decides, and a negative one is courtesy after departure', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId, departsAt: nowSec() - 30 * 60 })

    // Default 0 — departed half an hour ago, so nobody is coming.
    expect((await getFolios()).json.folios.find((f: any) => f.id === folioId).fulfillment)
      .toBe('no_show')

    // −60: an hour of courtesy. The SAME line, the same clock, a different organization policy.
    await setMargin(organizationId, -60)
    expect((await getFolios()).json.folios.find((f: any) => f.id === folioId).fulfillment)
      .toBe('pending')
  })

  it('S-5 — two of four boarded', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId, departsAt: nowSec() - 3 * HOUR, redeemedCount: 2 })

    expect((await getFolios()).json.folios.find((f: any) => f.id === folioId).fulfillment)
      .toBe('partial')
  })

  it('S-6 — a scan after the margin ends the no-show, with nothing to reverse', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    const lineId = await seedLine({ organizationId, folioId, departsAt: nowSec() - 3 * HOUR })

    expect((await getFolios()).json.folios.find((f: any) => f.id === folioId).fulfillment)
      .toBe('no_show')

    // Exactly what the scanner does, and the ONLY write involved.
    await env.DB.prepare(`UPDATE folio_lines SET redeemed_count = 4 WHERE id = ?`).bind(lineId).run()

    expect((await getFolios()).json.folios.find((f: any) => f.id === folioId).fulfillment)
      .toBe('fulfilled')
  })

  it('S-7 — the worst line wins, and `fulfilled` never masks a pending tour', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })

    const mixed = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId: mixed, departsAt: nowSec() - 3 * HOUR, redeemedCount: 4 })
    await seedLine({ organizationId, folioId: mixed, departsAt: nowSec() - 2 * HOUR, redeemedCount: 0 })

    const ahead = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId: ahead, departsAt: nowSec() - 3 * HOUR, redeemedCount: 4 })
    await seedLine({ organizationId, folioId: ahead, departsAt: nowSec() + 48 * HOUR, redeemedCount: 0 })

    const { json } = await getFolios()
    expect(json.folios.find((f: any) => f.id === mixed).fulfillment).toBe('no_show')
    expect(json.folios.find((f: any) => f.id === ahead).fulfillment).toBe('pending')
  })

  it('S-8 — a line with no readable departure is never accused', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    const lineId = await seedLine({ organizationId, folioId, departsAt: nowSec() - 3 * HOUR })
    await env.DB.prepare(`UPDATE folio_lines SET slot_date = NULL WHERE id = ?`).bind(lineId).run()

    expect((await getFolios()).json.folios.find((f: any) => f.id === folioId).fulfillment)
      .toBe('pending')
  })

  it('the detail carries the per-line breakdown the roll-up is made of', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId, departsAt: nowSec() - 3 * HOUR, redeemedCount: 4 })
    await seedLine({ organizationId, folioId, departsAt: nowSec() - 2 * HOUR, redeemedCount: 0 })

    const res = await SELF.fetch(`${FOLIOS}/${folioId}`, { headers: auth(ADMIN) })
    const body = (await res.json()) as any
    expect(body.folio.fulfillment).toBe('no_show')
    expect(body.folio.lines.map((l: any) => l.fulfillment).sort()).toEqual(['fulfilled', 'no_show'])
    expect(body.folio.lines.map((l: any) => l.redeemed_count).sort()).toEqual([0, 4])
  })

  it('S-10 — fulfilment is refused from a request body', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId, departsAt: nowSec() + 3 * HOUR })

    // There is no write path for it at all: the only mutation on a folio that takes a body is
    // cancel, and it cannot carry the axis. Asserting the READ is what matters — a client cannot
    // talk the server into a different answer.
    const res = await SELF.fetch(`${FOLIOS}?fulfillment=no_show`, { headers: auth(ADMIN) })
    const body = (await res.json()) as any
    expect(body.folios.find((f: any) => f.id === folioId).fulfillment).toBe('pending')
  })
})

describe('US-A85 — the seller reads the same fulfilment as the admin (US-AG50)', () => {
  it('the POS list carries it too', async () => {
    const { organizationId, userId } = await seedUser({ email: 'agente@empresa.com', role: 'agent' })
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId, departsAt: nowSec() - 3 * HOUR })

    const res = await SELF.fetch('http://api.local/api/pos/folios', {
      headers: auth('agente@empresa.com'),
    })
    const body = (await res.json()) as any
    expect(body.folios.find((f: any) => f.id === folioId).fulfillment).toBe('no_show')
  })
})

describe('US-A85 — the wasted-seat report', () => {
  it('counts the empty seats and groups them by departure', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const departsAt = nowSec() - 3 * HOUR
    const serviceId = crypto.randomUUID()

    const a = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId: a, departsAt, quantity: 4, redeemedCount: 0, serviceId })
    const b = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId: b, departsAt, quantity: 4, redeemedCount: 2, serviceId })

    const day = utcDay(departsAt)
    const res = await SELF.fetch(`${REPORT}?from=${day}&to=${day}`, { headers: auth(ADMIN) })
    const body = (await res.json()) as any

    expect(body.totals.seats_wasted).toBe(6) // 4 + 2
    expect(body.departures).toHaveLength(1)
    expect(body.departures[0].seats_sold).toBe(8)
    expect(body.departures[0].seats_redeemed).toBe(2)
    expect(body.departures[0].cents_wasted).toBe(200000 + 100000)
  })

  it('a departure that has not happened yet wastes nothing', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const departsAt = nowSec() + 48 * HOUR
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId, departsAt })

    const day = utcDay(departsAt)
    const res = await SELF.fetch(`${REPORT}?from=${day}&to=${day}`, { headers: auth(ADMIN) })
    expect(((await res.json()) as any).totals.seats_wasted).toBe(0)
  })

  it('a cancelled folio released its seat; that is not waste', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const departsAt = nowSec() - 3 * HOUR
    const folioId = await seedFolio({ organizationId, agentId: userId, status: 'cancelled' })
    await seedLine({ organizationId, folioId, departsAt })

    const day = utcDay(departsAt)
    const res = await SELF.fetch(`${REPORT}?from=${day}&to=${day}`, { headers: auth(ADMIN) })
    expect(((await res.json()) as any).totals.seats_wasted).toBe(0)
  })

  it('S-6b — `all_passes` cannot see a partial, and the report says which question it answers', async () => {
    const { organizationId, userId } = await seedUser({ email: ADMIN, role: 'admin' })
    const departsAt = nowSec() - 3 * HOUR
    const folioId = await seedFolio({ organizationId, agentId: userId })
    await seedLine({ organizationId, folioId, departsAt, quantity: 4, redeemedCount: 0 })

    const day = utcDay(departsAt)
    const perPass = await SELF.fetch(`${REPORT}?from=${day}&to=${day}`, { headers: auth(ADMIN) })
    expect(((await perPass.json()) as any).resolution).toBe('per_seat')

    await env.DB.prepare(`UPDATE organizations SET qr_redemption_mode = 'all_passes' WHERE id = ?`)
      .bind(organizationId)
      .run()
    const allPasses = await SELF.fetch(`${REPORT}?from=${day}&to=${day}`, { headers: auth(ADMIN) })
    const body = (await allPasses.json()) as any
    expect(body.redemption_mode).toBe('all_passes')
    // The org must be told the count can only separate "the party came" from "nobody came".
    expect(body.resolution).toBe('per_party')
  })

  it('an agent may not read the report → 403', async () => {
    const { organizationId } = await seedUser({ email: ADMIN, role: 'admin' })
    await seedUser({ email: 'agente@empresa.com', role: 'agent', organizationId })
    const res = await SELF.fetch(`${REPORT}?from=2026-01-01&to=2026-12-31`, {
      headers: auth('agente@empresa.com'),
    })
    expect(res.status).toBe(403)
  })
})

describe('Multitenancy isolation', () => {
  // S-18. The assertion is on the COUNT, not on presence: a dropped org filter shows up as org A
  // counting org B's seats, which is the failure this must catch.
  //
  // MUTATION-VERIFIED, and what it proves is narrower than it looks. Removing BOTH org predicates
  // from the report query turns this red (`expected 13 to be 4`). Removing EITHER ONE does not —
  // the two are equivalent by construction, since a folio_line's organization_id always equals its
  // folio's. So this test proves the query is org-scoped; it cannot prove WHICH predicate does the
  // work, and the second one is defence in depth that no test here justifies. Recorded rather than
  // hidden: the identical shape in US-A84 passed with the scope removed AND with the join removed,
  // and nobody noticed until it was mutated (folio-lifecycle-unification.spec.md S-18).
  it('S-18 — the report never counts another org\'s seats', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const departsAt = nowSec() - 3 * HOUR

    const a = await seedFolio({ organizationId: orgA.organizationId, agentId: orgA.adminUserId })
    await seedLine({ organizationId: orgA.organizationId, folioId: a, departsAt, quantity: 4, serviceName: 'Tour Isla Mujeres' })
    const b = await seedFolio({ organizationId: orgB.organizationId, agentId: orgB.adminUserId })
    await seedLine({ organizationId: orgB.organizationId, folioId: b, departsAt, quantity: 9, serviceName: 'Tour Isla Mujeres' })

    const day = utcDay(departsAt)
    const res = await SELF.fetch(`${REPORT}?from=${day}&to=${day}`, { headers: auth(orgA.adminEmail) })
    const body = (await res.json()) as any
    // 4, never 13 — the distinct quantities are what make a leak visible rather than plausible.
    expect(body.totals.seats_wasted).toBe(4)
    expect(body.departures).toHaveLength(1)
  })

  it('another org\'s folio carries no fulfilment into this org\'s list', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const b = await seedFolio({ organizationId: orgB.organizationId, agentId: orgB.adminUserId })
    await seedLine({ organizationId: orgB.organizationId, folioId: b, departsAt: nowSec() - 3 * HOUR })

    const { json } = await getFolios(orgA.adminEmail)
    expect(json.folios.find((f: any) => f.id === b)).toBeUndefined()
  })

  it('one org\'s no-show margin never moves another org\'s reading', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const departsAt = nowSec() - 30 * 60
    const a = await seedFolio({ organizationId: orgA.organizationId, agentId: orgA.adminUserId })
    await seedLine({ organizationId: orgA.organizationId, folioId: a, departsAt })
    const b = await seedFolio({ organizationId: orgB.organizationId, agentId: orgB.adminUserId })
    await seedLine({ organizationId: orgB.organizationId, folioId: b, departsAt })

    await setMargin(orgA.organizationId, -60) // an hour of courtesy for A only

    expect((await getFolios(orgA.adminEmail)).json.folios[0].fulfillment).toBe('pending')
    expect((await getFolios(orgB.adminEmail)).json.folios[0].fulfillment).toBe('no_show')
  })
})

describe('US-A85 — the margin is its own setting (D23)', () => {
  const patch = (email: string, body: unknown) =>
    SELF.fetch('http://api.local/api/organizations/me', {
      method: 'PUT',
      headers: { ...auth(email), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('round-trips through the org settings', async () => {
    await seedUser({ email: ADMIN, role: 'admin' })
    expect((await patch(ADMIN, { no_show_margin_minutes: -45 })).status).toBe(200)
    const res = await SELF.fetch('http://api.local/api/organizations/me', { headers: auth(ADMIN) })
    expect(((await res.json()) as any).organization.no_show_margin_minutes).toBe(-45)
  })

  it('S-4d — a customer may not be marked absent while their seat is still sellable', async () => {
    const { organizationId } = await seedUser({ email: ADMIN, role: 'admin' })
    // The org keeps selling 30 minutes past departure.
    await env.DB.prepare(`UPDATE organizations SET sales_cutoff_offset_minutes = -30 WHERE id = ?`)
      .bind(organizationId)
      .run()

    const res = await patch(ADMIN, { no_show_margin_minutes: 0 })
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('NO_SHOW_MARGIN_TOO_EARLY')

    // −30 or later is coherent: the seat stops being sellable and starts being wasted at the
    // same instant, never before.
    expect((await patch(ADMIN, { no_show_margin_minutes: -30 })).status).toBe(200)
  })

  it('S-4b — tuning the apartado release does not move the no-show line', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const departsAt = nowSec() - 3 * HOUR
    for (const o of [orgA, orgB]) {
      const f = await seedFolio({ organizationId: o.organizationId, agentId: o.adminUserId })
      await seedLine({ organizationId: o.organizationId, folioId: f, departsAt })
    }
    // The two orgs differ ONLY in the setting that governs the apartado's release.
    await env.DB.prepare(`UPDATE organizations SET booking_grace_offset_minutes = 15 WHERE id = ?`)
      .bind(orgA.organizationId).run()
    await env.DB.prepare(`UPDATE organizations SET booking_grace_offset_minutes = -30 WHERE id = ?`)
      .bind(orgB.organizationId).run()

    expect((await getFolios(orgA.adminEmail)).json.folios[0].fulfillment).toBe('no_show')
    expect((await getFolios(orgB.adminEmail)).json.folios[0].fulfillment).toBe('no_show')
  })
})
