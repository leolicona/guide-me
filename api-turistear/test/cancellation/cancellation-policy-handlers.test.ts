import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { seedUser, seedTwoOrgs, clearTenancyDb } from '../helpers/tenancy'
import { buildFakeJwt } from '../helpers/jwt'

// Cancellation Policy Engine — the WIRING.
// Spec: docs/cancellation/cancellation-policy-engine.spec.md (Scenarios 1–19, 31–32)
//
// The arithmetic is pinned down in cancellation-policy-engine.test.ts; this file asserts that the
// handlers reach it, persist what it decided, and write the right ledger rows. The load-bearing
// case is Scenario 10: with no policy configured NOTHING here changes, which is why
// folio-cancellation.test.ts and agent-balance-cash-drops.test.ts pass unedited.

const ADMIN = 'admin@empresa.com'
const AGENT = 'agent@empresa.com'
const auth = (email: string) => ({ Cookie: `gm_access=${buildFakeJwt(email)}` })
const jsonAuth = (email: string) => ({ ...auth(email), 'Content-Type': 'application/json' })
const FOLIOS = 'http://api.local/api/folios'
const ORGS = 'http://api.local/api/organizations'

// The spec's worked ladder.
const LADDER = {
  version: 1,
  tiers: [
    { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
    { min_hours: 0, refund_pct: 50, agent_commission_pct: 100 },
    { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
  ],
  booking_deposit_retained_pct: 100,
}

const ts = () => Math.floor(Date.now() / 1000)

// Test orgs are seeded in UTC (test/helpers/tenancy.ts), so a UTC wall-clock IS the org-local one.
// Departures are expressed as HOURS FROM NOW rather than calendar days on purpose: the ladder
// matches on time-distance, so "today at 08:00" is a no-show by lunchtime — exactly the calendar-vs-
// clock confusion D5 exists to prevent, and it would silently make every same-day case terminal.
const departureAt = (hoursFromNow: number) => {
  const d = new Date(Date.now() + hoursFromNow * 3_600_000)
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) }
}

// --- seeding ---------------------------------------------------------------

const setPolicy = (email: string, policy: unknown) =>
  SELF.fetch(`${ORGS}/me`, {
    method: 'PUT',
    headers: jsonAuth(email),
    body: JSON.stringify({ cancellation_policy: policy }),
  })

const seedService = async (organizationId: string) => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, base_price, minimum_price, default_capacity,
        status, commission_type, commission_value, created_at, updated_at)
     VALUES (?, ?, 'Tour', 100000, 50000, 20, 'active', 'percent', 1000, ?, ?)`,
  )
    .bind(id, organizationId, ts(), ts())
    .run()
  return id
}

const seedSlot = async (organizationId: string, serviceId: string, date: string, time = '08:00') => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO slots (id, organization_id, service_id, schedule_id, date, start_time, capacity,
        booked, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 20, 5, 'active', ?, ?)`,
  )
    .bind(id, organizationId, serviceId, date, time, ts(), ts())
    .run()
  return id
}

interface SeedFolio {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking'
  total?: number
  amountPaid?: number
  commissionAmount?: number
  policySnapshot?: unknown
  affiliateCompanyId?: string | null
}

const seedFolio = async (o: SeedFolio) => {
  const id = crypto.randomUUID()
  const total = o.total ?? 100_000
  await env.DB.prepare(
    `INSERT INTO folios (id, organization_id, agent_id, affiliate_company_id, customer_name, status,
        subtotal, discount_total, total, amount_paid, commission_amount,
        cancellation_policy_snapshot, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Cliente', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      o.organizationId,
      o.agentId,
      o.affiliateCompanyId ?? null,
      o.status ?? 'paid',
      total,
      total,
      o.amountPaid ?? total,
      o.commissionAmount ?? 10_000,
      o.policySnapshot === undefined ? null : JSON.stringify(o.policySnapshot),
      ts(),
      ts(),
    )
    .run()
  return id
}

const seedLine = async (o: {
  organizationId: string
  folioId: string
  serviceId: string
  slotId: string
  slotDate: string
  lineTotal?: number
  quantity?: number
  redeemedCount?: number
  slotStartTime?: string
}) => {
  const id = crypto.randomUUID()
  const lineTotal = o.lineTotal ?? 100_000
  await env.DB.prepare(
    `INSERT INTO folio_lines (id, organization_id, folio_id, service_id, slot_id, service_name,
        slot_date, slot_start_time, quantity, base_price, minimum_price, unit_price, line_total,
        commission_type, commission_value, redeemed_count, line_type, created_at)
     VALUES (?, ?, ?, ?, ?, 'Tour', ?, ?, ?, ?, 0, ?, ?, 'percent', 1000, ?, 'slot', ?)`,
  )
    .bind(
      id,
      o.organizationId,
      o.folioId,
      o.serviceId,
      o.slotId,
      o.slotDate,
      o.slotStartTime ?? '08:00',
      o.quantity ?? 1,
      lineTotal,
      lineTotal,
      lineTotal,
      o.redeemedCount ?? 0,
      ts(),
    )
    .run()
  return id
}

// The ledger rows a real sale would have written.
const seedLedger = async (o: {
  organizationId: string
  folioId: string
  collectedBy: string
  payments: Array<{ method: string; amount: number }>
  commission?: { method: string; amount: number }
}) => {
  for (const p of o.payments) {
    await env.DB.prepare(
      `INSERT INTO folio_payments (id, organization_id, folio_id, entry_type, amount, method,
          verification, collected_by, created_at)
       VALUES (?, ?, ?, 'payment', ?, ?, 'not_required', ?, ?)`,
    )
      .bind(crypto.randomUUID(), o.organizationId, o.folioId, p.amount, p.method, o.collectedBy, ts())
      .run()
  }
  if (o.commission) {
    await env.DB.prepare(
      `INSERT INTO folio_payments (id, organization_id, folio_id, entry_type, amount, method,
          verification, collected_by, created_at)
       VALUES (?, ?, ?, 'commission', ?, ?, 'not_required', ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        o.organizationId,
        o.folioId,
        o.commission.amount,
        o.commission.method,
        o.collectedBy,
        ts(),
      )
      .run()
  }
}

// --- reads -----------------------------------------------------------------

const folioRow = (id: string) =>
  env.DB.prepare(
    `SELECT status, refund_status, refund_amount, refund_pin, cancellation_clawback,
            cancellation_source, cancellation_reason FROM folios WHERE id = ?`,
  )
    .bind(id)
    .first<{
      status: string
      refund_status: string
      refund_amount: number | null
      refund_pin: string | null
      cancellation_clawback: number
      cancellation_source: string | null
      cancellation_reason: string | null
    }>()

const ledgerRows = async (folioId: string) => {
  const { results } = await env.DB.prepare(
    `SELECT entry_type, amount, method FROM folio_payments WHERE folio_id = ? ORDER BY entry_type, method`,
  )
    .bind(folioId)
    .all<{ entry_type: string; amount: number; method: string | null }>()
  return results
}

const netMoney = async (folioId: string) =>
  (await ledgerRows(folioId))
    .filter((r) => r.entry_type === 'payment' || r.entry_type === 'refund')
    .reduce((s, r) => s + r.amount, 0)

const netCommission = async (folioId: string) =>
  (await ledgerRows(folioId))
    .filter((r) => r.entry_type === 'commission' || r.entry_type === 'commission_reversal')
    .reduce((s, r) => s + r.amount, 0)

const cancel = async (email: string, id: string, body: Record<string, unknown> = {}) => {
  const res = await SELF.fetch(`${FOLIOS}/${id}/cancel`, {
    method: 'POST',
    headers: jsonAuth(email),
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}

const getFolio = async (email: string, id: string) => {
  const res = await SELF.fetch(`${FOLIOS}/${id}`, { headers: auth(email) })
  return { status: res.status, json: (await res.json()) as any }
}

const clearDb = async () => {
  for (const t of [
    'cancellation_requests',
    'folio_access_tokens',
    'folio_line_extras',
    'folio_lines',
    'folio_payments',
    'folios',
    'slot_zones',
    'service_zones',
    'slots',
    'schedules',
    'service_extras',
    'services',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
})
afterEach(() => vi.restoreAllMocks())

// A configured org with one paid tour folio departing `hours` from now.
// `policy: null` means the org has NO ladder — the D1 gate, i.e. today's behaviour.
const scenario = async (opts: { hours: number; policy?: unknown | null } = { hours: 144 }) => {
  const policy = opts.policy === undefined ? LADDER : opts.policy
  const { organizationId, userId: adminId } = await seedUser({ email: ADMIN, role: 'admin' })
  const { userId: agentId } = await seedUser({ email: AGENT, role: 'agent', organizationId })
  if (policy !== null) await setPolicy(ADMIN, policy)
  const serviceId = await seedService(organizationId)
  const { date, time } = departureAt(opts.hours)
  const slotId = await seedSlot(organizationId, serviceId, date, time)
  const folioId = await seedFolio({
    organizationId,
    agentId,
    policySnapshot: policy === null ? undefined : policy,
  })
  await seedLine({ organizationId, folioId, serviceId, slotId, slotDate: date, slotStartTime: time })
  await seedLedger({
    organizationId,
    folioId,
    collectedBy: agentId,
    payments: [{ method: 'cash', amount: 100_000 }],
    commission: { method: 'cash', amount: 10_000 },
  })
  return { organizationId, adminId, agentId, serviceId, slotId, folioId, date, time }
}

// ---------------------------------------------------------------------------
describe('Scenario 1 — the ladder end to end', () => {
  it('6 days out → full refund, nothing retained', async () => {
    const { folioId } = await scenario({ hours: 144 })
    const { status, json } = await cancel(ADMIN, folioId)
    expect(status).toBe(200)
    expect(json.cancellation).toMatchObject({ refund: 100_000, retention: 0 })
    const row = await folioRow(folioId)
    expect(row).toMatchObject({ status: 'cancelled', refund_status: 'pending', refund_amount: 100_000 })
    expect(await netMoney(folioId)).toBe(0)
  })

  it('same day → half refunded, half RETAINED and still live in the ledger', async () => {
    const { folioId } = await scenario({ hours: 3 })
    const { json } = await cancel(ADMIN, folioId)
    expect(json.cancellation).toMatchObject({ refund: 50_000, retention: 50_000 })
    // The retained half is the point of the whole feature: it stays in the ledger as revenue the
    // agent is holding, instead of vanishing with a full reversal.
    expect(await netMoney(folioId)).toBe(50_000)
    expect(await folioRow(folioId)).toMatchObject({ refund_amount: 50_000, refund_status: 'pending' })
  })

  it('after departure (no-show) → nothing refunded, no refund row, no PIN', async () => {
    const { folioId } = await scenario({ hours: -2 })
    const { json } = await cancel(ADMIN, folioId)
    expect(json.cancellation).toMatchObject({ refund: 0, retention: 100_000 })
    const row = await folioRow(folioId)
    expect(row?.refund_status).toBe('none')
    expect(row?.refund_pin).toBeNull()
    expect((await ledgerRows(folioId)).some((r) => r.entry_type === 'refund')).toBe(false)
    expect(await netMoney(folioId)).toBe(100_000)
  })
})

describe('Scenario 3 — a redeemed line retains everything (D7)', () => {
  it('retains the delivered line in full and refunds only the rest', async () => {
    const { organizationId, agentId, serviceId, folioId } = await scenario({ hours: 3 })
    // Replace the single line with two 50k lines, the first already scanned. A distinct departure
    // hour so the slot does not collide with the one the scenario already seeded — still inside the
    // same-day tier.
    await env.DB.exec(`DELETE FROM folio_lines`)
    const { date, time } = departureAt(4)
    const slotId = await seedSlot(organizationId, serviceId, date, time)
    await seedLine({
      organizationId, folioId, serviceId, slotId, slotDate: date, slotStartTime: time,
      lineTotal: 50_000, redeemedCount: 1,
    })
    await seedLine({ organizationId, folioId, serviceId, slotId, slotDate: date, slotStartTime: time, lineTotal: 50_000 })

    const { json } = await cancel(ADMIN, folioId)
    // 50_000 (delivered, full) + 25_000 (half of the unused line) = 75_000 retained.
    expect(json.cancellation).toMatchObject({ refund: 25_000, retention: 75_000 })
  })
})

describe('Scenario 4 — the booking deposit floor (US-AG07.4 preserved)', () => {
  it('a booking refunds nothing at 100%, even under a full-refund tier', async () => {
    const { organizationId, agentId, serviceId, folioId } = await scenario({ hours: 144 })
    await env.DB.prepare(`UPDATE folios SET status = 'booking', amount_paid = 30000 WHERE id = ?`)
      .bind(folioId)
      .run()
    const { json } = await cancel(ADMIN, folioId)
    expect(json.cancellation.refund).toBe(0)
    expect(await folioRow(folioId)).toMatchObject({ refund_status: 'none' })
  })

  it('at 0% the deposit follows the ladder', async () => {
    const policy = { ...LADDER, booking_deposit_retained_pct: 0 }
    const { folioId } = await scenario({ hours: 144, policy })
    await env.DB.prepare(`UPDATE folios SET status = 'booking', amount_paid = 30000 WHERE id = ?`)
      .bind(folioId)
      .run()
    const { json } = await cancel(ADMIN, folioId)
    expect(json.cancellation.refund).toBe(30_000)
  })
})

describe('Scenario 7 — commission follows the tier (US-A70)', () => {
  it('same-day keeps the commission; the ledger writes no reversal', async () => {
    const { folioId } = await scenario({ hours: 3 })
    await cancel(ADMIN, folioId)
    expect(await netCommission(folioId)).toBe(10_000)
    expect(await folioRow(folioId)).toMatchObject({ cancellation_clawback: 0 })
  })

  it('an early cancellation reverses it in full', async () => {
    const { folioId } = await scenario({ hours: 144 })
    await cancel(ADMIN, folioId)
    expect(await netCommission(folioId)).toBe(0)
    expect(await folioRow(folioId)).toMatchObject({ cancellation_clawback: 1 })
  })

  it('a partial percentage reverses only part', async () => {
    const policy = {
      ...LADDER,
      tiers: [
        { min_hours: 0, refund_pct: 50, agent_commission_pct: 40 },
        { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
      ],
    }
    const { folioId } = await scenario({ hours: 3, policy })
    await cancel(ADMIN, folioId)
    expect(await netCommission(folioId)).toBe(4_000)
  })
})

describe('Scenario 9 — cancelled by the company (US-A71)', () => {
  it('overrides the ladder: full refund, commission intact, marked in the reason', async () => {
    const { folioId } = await scenario({ hours: 3 }) // a 50% tier
    const { json } = await cancel(ADMIN, folioId, {
      cancelled_by_company: true,
      reason: 'Mal clima',
    })
    expect(json.cancellation).toMatchObject({ refund: 100_000, retention: 0, reversed_commission: 0 })
    const row = await folioRow(folioId)
    expect(row?.cancellation_source).toBe('company')
    expect(row?.cancellation_reason).toMatch(/^\[EMPRESA\]/)
    expect(row?.cancellation_clawback).toBe(0)
    expect(await netCommission(folioId)).toBe(10_000)
    expect(await netMoney(folioId)).toBe(0)
  })
})

describe('Rule 6 — the ladder is binding (D10)', () => {
  it('ignores the body clawback flag once a policy is configured', async () => {
    const { folioId } = await scenario({ hours: 144 }) // tier says agent keeps 0%
    await cancel(ADMIN, folioId, { clawback: false }) // the admin asks to absorb it
    expect(await folioRow(folioId)).toMatchObject({ cancellation_clawback: 1 })
    expect(await netCommission(folioId)).toBe(0)
  })
})

describe('Scenario 14/15 — proportional ledger reversal across methods', () => {
  it('splits the refund in proportion to what each method collected', async () => {
    const { organizationId, agentId, folioId } = await scenario({ hours: 3 })
    await env.DB.exec(`DELETE FROM folio_payments`)
    await seedLedger({
      organizationId,
      folioId,
      collectedBy: agentId,
      payments: [
        { method: 'cash', amount: 30_000 },
        { method: 'transfer', amount: 70_000 },
      ],
    })
    await cancel(ADMIN, folioId)
    const refunds = (await ledgerRows(folioId)).filter((r) => r.entry_type === 'refund')
    expect(refunds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'cash', amount: -15_000 }),
        expect.objectContaining({ method: 'transfer', amount: -35_000 }),
      ]),
    )
    expect(refunds.reduce((s, r) => s + r.amount, 0)).toBe(-50_000)
    expect(await netMoney(folioId)).toBe(50_000)
  })
})

describe('Scenario 10 — NO policy: the pre-feature path, untouched (D1)', () => {
  it('records no refund for a tour and reverses the ledger in full', async () => {
    const { folioId } = await scenario({ hours: 3, policy: null })
    const { status, json } = await cancel(ADMIN, folioId, { clawback: true })
    expect(status).toBe(200)
    // No `cancellation` block — the legacy response shape is unchanged.
    expect(json.cancellation).toBeUndefined()
    const row = await folioRow(folioId)
    expect(row?.refund_status).toBe('none')
    expect(row?.cancellation_clawback).toBe(1) // the body flag still decides
    expect(await netMoney(folioId)).toBe(0) // reversed in full
    expect(await netCommission(folioId)).toBe(0)
  })

  it('honours clawback:false the old way', async () => {
    const { folioId } = await scenario({ hours: 3, policy: null })
    await cancel(ADMIN, folioId, { clawback: false })
    expect(await netCommission(folioId)).toBe(10_000)
  })
})

describe('Scenario 11/12 — the snapshot (D6)', () => {
  it('editing the org policy does NOT re-price a sale already made', async () => {
    const { folioId } = await scenario({ hours: 3 }) // snapshotted with the 50% tier
    // The org hardens its policy to 0% everywhere AFTER the sale.
    await setPolicy(ADMIN, {
      version: 1,
      tiers: [{ min_hours: null, refund_pct: 0, agent_commission_pct: 100 }],
      booking_deposit_retained_pct: 100,
    })
    const { json } = await cancel(ADMIN, folioId)
    expect(json.cancellation.refund).toBe(50_000) // the snapshot, not the new ladder
  })

  it('clearing the org policy leaves snapshotted folios priced by their own', async () => {
    const { folioId } = await scenario({ hours: 3 })
    await setPolicy(ADMIN, null)
    const { json } = await cancel(ADMIN, folioId)
    expect(json.cancellation.refund).toBe(50_000)
  })

  it('a folio with no snapshot falls back to the org policy', async () => {
    const { organizationId, agentId, serviceId } = await scenario({ hours: 3 })
    const { date, time } = departureAt(5) // its own departure hour — same tier, distinct slot
    const slotId = await seedSlot(organizationId, serviceId, date, time)
    const legacy = await seedFolio({ organizationId, agentId, policySnapshot: undefined })
    await seedLine({ organizationId, folioId: legacy, serviceId, slotId, slotDate: date, slotStartTime: time })
    await seedLedger({
      organizationId, folioId: legacy, collectedBy: agentId,
      payments: [{ method: 'cash', amount: 100_000 }],
    })
    const { json } = await cancel(ADMIN, legacy)
    expect(json.cancellation.refund).toBe(50_000)
  })
})

describe('the tourist-request path prices identically (the defect this fixes)', () => {
  const approve = async (email: string, requestId: string) => {
    const res = await SELF.fetch(`${FOLIOS}/cancellation-requests/${requestId}/approve`, {
      method: 'POST',
      headers: jsonAuth(email),
      body: JSON.stringify({}),
    })
    return { status: res.status, json: (await res.json()) as any }
  }

  it('approving a request refunds what the LADDER says, not the full amount', async () => {
    const { organizationId, folioId } = await scenario({ hours: 3 })
    const requestId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO cancellation_requests (id, organization_id, folio_id, status, reason, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'Ya no puedo ir', ?, ?)`,
    )
      .bind(requestId, organizationId, folioId, ts(), ts())
      .run()

    const { status } = await approve(ADMIN, requestId)
    expect(status).toBe(200)
    const row = await folioRow(folioId)
    // Pre-feature this was a full 100_000 refund — the same folio an admin cancel recorded as 0.
    expect(row?.refund_amount).toBe(50_000)
    expect(row?.cancellation_source).toBe('tourist_request')
    expect(await netMoney(folioId)).toBe(50_000)
  })
})

describe('cancellation_quote on folio detail', () => {
  it('quotes what cancelling now would cost, without persisting anything', async () => {
    const { folioId } = await scenario({ hours: 3 })
    const { json } = await getFolio(ADMIN, folioId)
    expect(json.cancellation_quote).toMatchObject({ refund: 50_000, retention: 50_000 })
    expect(json.cancellation_quote.lines[0]).toMatchObject({ refund_pct: 50, retention: 50_000 })
    // Nothing was written.
    expect((await folioRow(folioId))?.status).toBe('paid')
  })

  it('is null when the org has no policy', async () => {
    const { folioId } = await scenario({ hours: 3, policy: null })
    expect((await getFolio(ADMIN, folioId)).json.cancellation_quote).toBeNull()
  })

  it('is null once the folio is cancelled — there is nothing left to quote', async () => {
    const { folioId } = await scenario({ hours: 3 })
    await cancel(ADMIN, folioId)
    expect((await getFolio(ADMIN, folioId)).json.cancellation_quote).toBeNull()
  })
})

describe('Scenario 31/32 — multitenancy', () => {
  it('one org\'s ladder never prices another org\'s folio', async () => {
    const { orgA, orgB } = await seedTwoOrgs()
    await setPolicy(orgA.adminEmail, LADDER)

    const { date, time } = departureAt(3)
    const svcB = await seedService(orgB.organizationId)
    const slotB = await seedSlot(orgB.organizationId, svcB, date, time)
    const folioB = await seedFolio({ organizationId: orgB.organizationId, agentId: orgB.adminUserId })
    await seedLine({
      organizationId: orgB.organizationId, folioId: folioB, serviceId: svcB, slotId: slotB, slotDate: date, slotStartTime: time,
    })
    await seedLedger({
      organizationId: orgB.organizationId, folioId: folioB, collectedBy: orgB.adminUserId,
      payments: [{ method: 'cash', amount: 100_000 }],
    })

    // org_a cannot even see it.
    expect((await cancel(orgA.adminEmail, folioB)).status).toBe(404)
    // org_b cancels its own with NO policy — org_a's ladder is never consulted.
    const { json } = await cancel(orgB.adminEmail, folioB)
    expect(json.cancellation).toBeUndefined()
    expect((await folioRow(folioB))?.refund_status).toBe('none')
  })

  it('injected money fields are ignored — the computed refund wins', async () => {
    const { folioId } = await scenario({ hours: 3 })
    await cancel(ADMIN, folioId, {
      refund_amount: 999_999,
      cancellation_retention: 0,
      organizationId: 'org_other',
    })
    expect((await folioRow(folioId))?.refund_amount).toBe(50_000)
  })
})
