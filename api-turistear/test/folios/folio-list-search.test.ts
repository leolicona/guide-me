import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// US-A83 — finding one sale among a hundred.
// Spec: docs/oversight/folio-list-search.spec.md (S-1…S-9, S-12).
//
// Two things are worth pinning here and nothing else is: that the query matches the five fields a
// folio really gets described by, and that a query or a range REACHES PAST the load window US-A84
// installed. A search that quietly kept the window would be a search with a hidden date filter.

const ADMIN_EMAIL = 'admin@empresa.com'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const FOLIOS = 'http://api.local/api/folios'

const nowSec = () => Math.floor(Date.now() / 1000)
const daysAgo = (d: number) => nowSec() - d * 86400

/**
 * `seedUser` seeds every test organization with `timezone = 'UTC'` (`helpers/tenancy.ts:47`) — NOT
 * the schema's `America/Mexico_City` default. So the ordinary calendar helper below is UTC, and a
 * test that wants to prove anything about time zones has to set one, which is what `withTz` is for.
 * Without that, a "the range is org-local" assertion passes against a UTC org no matter how the
 * server computes the day, and proves nothing.
 */
const orgDay = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString('en-CA', { timeZone: 'UTC' })

const withTz = (organizationId: string, tz: string) =>
  env.DB.prepare('UPDATE organizations SET timezone = ? WHERE id = ?').bind(tz, organizationId).run()

interface SeedOpts {
  organizationId: string
  agentId: string
  id?: string
  customerName?: string | null
  customerPhone?: string | null
  createdAt?: number
}

const seedFolio = async ({
  organizationId,
  agentId,
  id = crypto.randomUUID(),
  customerName = 'John Diver',
  customerPhone = null,
  createdAt = nowSec(),
}: SeedOpts): Promise<string> => {
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, customer_name, customer_email, customer_phone,
        status, subtotal, discount_total, total, amount_paid, created_at, updated_at,
        payment_verification, tickets_sent_at, tickets_viewed_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'paid', 100000, 0, 100000, 100000, ?, ?, 'verified', ?, ?)`,
  )
    .bind(id, organizationId, agentId, customerName, customerPhone, createdAt, createdAt, createdAt, createdAt)
    .run()
  return id
}

const seedLine = async (organizationId: string, folioId: string, serviceName: string) => {
  const serviceId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services
       (id, organization_id, name, description, base_price, minimum_price, default_capacity,
        status, created_at, updated_at)
     VALUES (?, ?, ?, '', 50000, 40000, 20, 'active', ?, ?)`,
  )
    .bind(serviceId, organizationId, serviceName, nowSec(), nowSec())
    .run()
  await env.DB.prepare(
    `INSERT INTO folio_lines
       (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date,
        slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
        qr_token, redeemed_count, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, '2026-08-10', '08:00', 2, 50000, 40000, 50000, 100000, NULL, 0, ?)`,
  )
    .bind(crypto.randomUUID(), organizationId, folioId, serviceId, serviceName, nowSec())
    .run()
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM folio_lines')
  await env.DB.exec('DELETE FROM services')
  await env.DB.exec('DELETE FROM folio_payments')
  await env.DB.exec('DELETE FROM notifications')
  await env.DB.exec('DELETE FROM folios')
  await clearTenancyDb()
})

const list = async (query: string, email = ADMIN_EMAIL) => {
  const res = await SELF.fetch(`${FOLIOS}?${query}`, { headers: auth(email) })
  expect(res.status).toBe(200)
  return res.json<{
    folios: Array<Record<string, unknown>>
    window_days: number | null
    truncated: boolean
  }>()
}

const ids = (body: { folios: Array<Record<string, unknown>> }) => body.folios.map((f) => f.id)

// --- The five fields (rule 4) --------------------------------------------------

describe('US-A83 — the query matches what a folio gets described by', () => {
  it('S-1 — the SERVICE finds a sale nobody typed a name for', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const wanted = await seedFolio({ organizationId, agentId: userId, customerName: null })
    await seedLine(organizationId, wanted, 'Tour Isla Mujeres')
    const other = await seedFolio({ organizationId, agentId: userId, customerName: 'Pedro' })
    await seedLine(organizationId, other, 'Chichén Itzá')

    // The Express case: no name at all, findable only by what was sold.
    expect(ids(await list('q=isla'))).toEqual([wanted])
  })

  it('S-2 — accents and case do not defeat it', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({
      organizationId, agentId: userId, customerName: 'María Fernández',
    })

    for (const q of ['maria', 'MARIA', 'fernandez', 'María']) {
      expect(ids(await list(`q=${encodeURIComponent(q)}`)), q).toEqual([id])
    }
  })

  it('S-2b — ñ is normalised too, in both directions', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({ organizationId, agentId: userId, customerName: 'Muñoz' })

    expect(ids(await list('q=munoz'))).toEqual([id])
  })

  it('S-3 — the phone matches by DIGITS, however either side is written', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({
      organizationId, agentId: userId, customerName: null, customerPhone: '+52 998 123 4567',
    })

    expect(ids(await list('q=9981234567'))).toEqual([id])
    expect(ids(await list(`q=${encodeURIComponent('998-123')}`))).toEqual([id])
  })

  it('the folio ref matches — the same 8 characters the WhatsApp template renders', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({ organizationId, agentId: userId, id: 'abcdef12-0000-4000-8000-000000000001' })
    await seedFolio({ organizationId, agentId: userId })

    expect(ids(await list('q=abcdef12'))).toEqual([id])
  })

  it('S-4 — the SELLER is searchable, with its stated cost', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL, name: 'Ana Ramírez' })
    const soldByAna = await seedFolio({ organizationId, agentId: userId, customerName: 'Pedro' })
    const soldToAna = await seedFolio({ organizationId, agentId: userId, customerName: 'Ana Gómez' })

    // D2 — accepted, not a defect: `Ana` returns sales TO Ana and sales BY Ana. Recorded here so
    // the behaviour is a decision on the record rather than a surprise in the field.
    expect(ids(await list('q=ana')).sort()).toEqual([soldByAna, soldToAna].sort())
  })

  it('S-5 — a query below the floor is not a filter', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({ organizationId, agentId: userId, customerName: 'Leo' })
    await seedFolio({ organizationId, agentId: userId, customerName: 'Zoe' })

    // `%a%` would scan the table to return everything, which is not a search (rule 7).
    const body = await list('q=a')
    expect(body.folios).toHaveLength(2)
    // And with no real query, the window is still in force.
    expect(body.window_days).toBe(30)
  })

  it('a folio with three matching lines appears ONCE', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({ organizationId, agentId: userId })
    await seedLine(organizationId, id, 'Tour Isla Mujeres')
    await seedLine(organizationId, id, 'Tour Contoy')
    await seedLine(organizationId, id, 'Tour Cozumel')

    // `EXISTS`, not a join — a join would return the same folio three times.
    expect(ids(await list('q=tour'))).toEqual([id])
  })
})

// --- Reaching past the window (D11/D12) ----------------------------------------

describe('US-A83 — a query and a range reach past the load window', () => {
  it('S-6 — a query finds a folio far outside the 30-day window', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const old = await seedFolio({
      organizationId, agentId: userId, customerName: 'Leo Licona', createdAt: daysAgo(200),
    })

    // Without D12 this returns nothing: the folio is settled, delivered and outside the window, so
    // the union does not load it. A search that kept the window would be a search with a hidden
    // date filter — the exact thing the fallback exists to remove.
    const body = await list('q=leo')
    expect(ids(body)).toEqual([old])
    expect(body.window_days).toBeNull()
  })

  it('S-8 — a date range reaches past the window and replaces it', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const created = daysAgo(200)
    const old = await seedFolio({ organizationId, agentId: userId, createdAt: created })
    await seedFolio({ organizationId, agentId: userId, createdAt: daysAgo(1) })

    const day = orgDay(created)
    const body = await list(`from=${day}&to=${day}`)

    expect(ids(body)).toEqual([old])
    expect(body.window_days).toBeNull()
  })

  it('S-9 — the range is the ORGANIZATION’s day, not UTC', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    // Cancún is UTC−5 year round (Mexico abolished DST in 2022), so a sale at 23:30 local falls on
    // the NEXT UTC day. This is the whole defect: a beach counter's evening sales answered for
    // tomorrow under `strftime(… 'unixepoch')`.
    await withTz(organizationId, 'America/Cancun')

    const localDay = '2026-07-15'
    const lateNight = Math.floor(new Date(`${localDay}T23:30:00-05:00`).getTime() / 1000)
    expect(new Date(lateNight * 1000).toISOString().slice(0, 10)).toBe('2026-07-16') // UTC disagrees

    const id = await seedFolio({ organizationId, agentId: userId, createdAt: lateNight })

    // Asking for the seller's day must return the sale the seller made that day…
    expect(ids(await list(`from=${localDay}&to=${localDay}`))).toEqual([id])
    // …and asking for the UTC day it *used* to answer for must not.
    expect(ids(await list('from=2026-07-16&to=2026-07-16'))).toEqual([])
  })

  it('an open-ended range works from either side', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const old = await seedFolio({ organizationId, agentId: userId, createdAt: daysAgo(200) })
    const recent = await seedFolio({ organizationId, agentId: userId, createdAt: daysAgo(1) })

    expect(ids(await list(`to=${orgDay(daysAgo(100))}`))).toEqual([old])
    expect(ids(await list(`from=${orgDay(daysAgo(100))}`))).toEqual([recent])
  })

  it('a malformed date falls through to "no filter", like every other parameter', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({ organizationId, agentId: userId })

    const body = await list('from=ayer&to=hoy')
    expect(body.folios).toHaveLength(1)
    expect(body.window_days).toBe(30)
  })

  it('a query composes with the other filters rather than replacing them', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const paid = await seedFolio({ organizationId, agentId: userId, customerName: 'Leo Uno' })
    const cancelled = await seedFolio({ organizationId, agentId: userId, customerName: 'Leo Dos' })
    await env.DB.prepare(`UPDATE folios SET status = 'cancelled' WHERE id = ?`).bind(cancelled).run()

    // Rule 5 — a query is a filter, not a different endpoint.
    expect(ids(await list('q=leo&status=paid'))).toEqual([paid])
  })
})

// --- The cap (D6) ---------------------------------------------------------------

describe('US-A83 — the cap announces itself', () => {
  it('S-7 — 50 rows, and `truncated` when there were more', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    for (let i = 0; i < 55; i++) {
      await seedFolio({
        organizationId, agentId: userId, customerName: `Tourista ${i}`, createdAt: daysAgo(100 + i),
      })
    }

    const body = await list('q=tourista')

    // A cap that does not announce itself reports "these are the matches" when it means "these are
    // the first 50" — the same silent lie the union was built to prevent, one layer down.
    expect(body.folios).toHaveLength(50)
    expect(body.truncated).toBe(true)
  })

  it('does not claim truncation when everything fit', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    await seedFolio({ organizationId, agentId: userId, customerName: 'Leo' })

    const body = await list('q=leo')
    expect(body.folios).toHaveLength(1)
    expect(body.truncated).toBe(false)
  })

  it('the capped page still carries its decorations', async () => {
    const { userId, organizationId } = await seedUser({ email: ADMIN_EMAIL })
    const id = await seedFolio({ organizationId, agentId: userId, customerName: 'Leo' })
    await seedLine(organizationId, id, 'Tour Isla Mujeres')

    // The decorations switch to an id list on the search path (bounded at 50) instead of re-applying
    // the filters, which would fetch lines for every folio the query matched and discard most.
    const body = await list('q=leo')
    expect(body.folios[0].lines).toHaveLength(1)
  })
})

// --- Multitenancy ----------------------------------------------------------------

describe('US-A83 — multitenancy', () => {
  it('S-12 — a query never reaches another organization', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    const mine = await seedFolio({
      organizationId: orgA.organizationId, agentId: orgA.adminUserId, customerName: 'Leo Mío',
    })
    await seedFolio({
      organizationId: orgB.organizationId, agentId: orgB.adminUserId, customerName: 'Leo Ajeno',
    })

    // SAME-ORG ATTRIBUTION, not foreign-row absence: org A holds its OWN `Leo`, so a dropped org
    // scope returns two rows and fails this. An assertion that only checked "org A sees no Leo"
    // would pass against a scope that never existed (folio-lifecycle-unification.spec.md S-18).
    expect(ids(await list('q=leo', orgA.adminEmail))).toEqual([mine])
  })

  it('a service name from another org never matches', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await seedFolio({ organizationId: orgA.organizationId, agentId: orgA.adminUserId, customerName: 'Ana' })
    const theirs = await seedFolio({
      organizationId: orgB.organizationId, agentId: orgB.adminUserId, customerName: 'Ana',
    })
    await seedLine(orgB.organizationId, theirs, 'Tour Secreto')

    // MUTATION-TESTED and reported honestly: removing `eq(folioLines.organizationId, org)` from the
    // EXISTS subquery leaves this green. It has to — the subquery keys on `folio_lines.folio_id =
    // folios.id`, and `folios` is already org-scoped by the outer `filters`, so a foreign line can
    // only ever attach to a folio the outer query has already excluded. That scope is defence in
    // depth, exactly as `folio-lifecycle-unification.spec.md` S-18 found for the decorations.
    //
    // What this DOES prove is the shape of the result: the query does not leak through the join,
    // and org A's own folio is not dragged in by a foreign line's name.
    expect(ids(await list('q=secreto', orgA.adminEmail))).toEqual([])
  })
})
