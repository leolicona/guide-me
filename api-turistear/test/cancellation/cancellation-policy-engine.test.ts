import { describe, it, expect } from 'vitest'
import {
  cancellationPolicySchema,
  computeCancellationRefund,
  parseCancellationPolicy,
  resolvePolicy,
  DEFAULT_CANCELLATION_POLICY,
  type CancellationPolicy,
  type PolicyLine,
} from '../../src/utils/cancellationPolicy'
import { naiveEpoch } from '../../src/utils/tz'
import { prorateAcrossBuckets } from '../../src/utils/folioPayments'

// Cancellation Policy Engine — the PURE core.
// Spec: docs/cancellation/cancellation-policy-engine.spec.md (§ The computation).
//
// No DB, no HTTP, no clock: every case injects `nowEpoch` and reads the arithmetic back. This is
// where the money decisions are pinned down — the handler tests assert wiring, not maths.

const TZ = 'America/Mexico_City'

// The spec's worked ladder: 5 days out → full refund; inside that but before departure → half;
// after departure (a no-show) → nothing. Commission mirrors it: nothing earned on an early
// cancellation, kept in full once the company retained something.
const LADDER: CancellationPolicy = cancellationPolicySchema.parse({
  version: 1,
  tiers: [
    { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
    { min_hours: 0, refund_pct: 50, agent_commission_pct: 100 },
    { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
  ],
})

// 2026-06-15 08:00 org-local, as an absolute instant.
const DEPARTURE = { date: '2026-06-15', time: '08:00' }
const departureEpoch = naiveEpoch(DEPARTURE.date, DEPARTURE.time, TZ)
const hoursBefore = (h: number) => departureEpoch - Math.round(h * 3600)

const tourLine = (over: Partial<PolicyLine> = {}): PolicyLine => ({
  id: 'fl_1',
  lineTotal: 100_000,
  quantity: 1,
  redeemedCount: 0,
  commissionType: 'percent',
  commissionValue: 1000, // 10% in basis points
  lineType: 'slot',
  slotDate: DEPARTURE.date,
  slotStartTime: DEPARTURE.time,
  checkIn: null,
  ...over,
})

const compute = (over: Partial<Parameters<typeof computeCancellationRefund>[0]> = {}) =>
  computeCancellationRefund({
    policy: LADDER,
    lines: [tourLine()],
    amountPaid: 100_000,
    nowEpoch: hoursBefore(200),
    timezone: TZ,
    sellerKind: 'agent',
    ...over,
  })

// ---------------------------------------------------------------------------
// Tier matching
// ---------------------------------------------------------------------------
describe('tier matching', () => {
  it('picks the top tier well before departure', () => {
    const out = compute({ nowEpoch: hoursBefore(200) })
    expect(out.refund).toBe(100_000)
    expect(out.retention).toBe(0)
  })

  it('is inclusive at the boundary — exactly 120h out still refunds in full', () => {
    const out = compute({ nowEpoch: hoursBefore(120) })
    expect(out.refund).toBe(100_000)
  })

  it('drops a tier one minute inside the boundary', () => {
    const out = compute({ nowEpoch: hoursBefore(120) + 60 })
    expect(out.refund).toBe(50_000)
    expect(out.retention).toBe(50_000)
  })

  it('falls to the terminal tier once departure has passed (a no-show)', () => {
    const out = compute({ nowEpoch: departureEpoch + 3600 })
    expect(out.refund).toBe(0)
    expect(out.retention).toBe(100_000)
  })

  it('treats a line with no readable departure as already departed', () => {
    const out = compute({ lines: [tourLine({ slotDate: null })] })
    expect(out.refund).toBe(0)
    expect(out.lines[0]!.hoursOut).toBe(Number.NEGATIVE_INFINITY)
  })
})

// ---------------------------------------------------------------------------
// D5 — hours of time-distance, in the ORG's zone (not calendar days, not UTC)
// ---------------------------------------------------------------------------
describe('time-distance in the org timezone (D5)', () => {
  it('a calendar-tomorrow departure only hours away takes the SAME-DAY tier', () => {
    // 23:00 the night before a 08:00 departure: nine hours out, but "tomorrow" on the calendar.
    // Measuring in calendar days would hand back the full amount here (this is the 0052 bug shape).
    const out = compute({ nowEpoch: hoursBefore(9) })
    expect(out.lines[0]!.refundPct).toBe(50)
    expect(out.refund).toBe(50_000)
  })

  it('resolves the departure in the org zone, not UTC', () => {
    // 08:00 in Mexico City is 14:00 UTC. An instant 13:00 UTC on the departure date is one hour
    // BEFORE departure locally; read as UTC it would look like five hours after.
    const oneHourBefore = Math.floor(Date.UTC(2026, 5, 15, 13, 0, 0) / 1000)
    const out = compute({ nowEpoch: oneHourBefore })
    expect(out.lines[0]!.hoursOut).toBeCloseTo(1, 5)
    expect(out.lines[0]!.refundPct).toBe(50) // still pre-departure
  })

  it('a stay line departs at check-in 00:00 org-local (D11)', () => {
    const stay: PolicyLine = tourLine({
      lineType: 'stay',
      slotDate: null,
      slotStartTime: null,
      checkIn: '2026-06-15',
    })
    // 2026-06-14 20:00 local — four hours before the check-in day begins.
    const out = compute({ lines: [stay], nowEpoch: naiveEpoch('2026-06-14', '20:00', TZ) })
    expect(out.lines[0]!.hoursOut).toBeCloseTo(4, 5)
    expect(out.lines[0]!.refundPct).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// D4 — per-line evaluation, retentions summed
// ---------------------------------------------------------------------------
describe('per-line evaluation (D4)', () => {
  it('the spec worked example: 600 tomorrow + 400 in 8 days, 1000 paid', () => {
    const near = tourLine({ id: 'a', lineTotal: 600, commissionValue: 1000 }) // departs in 20h
    const far = tourLine({
      id: 'b',
      lineTotal: 400,
      commissionValue: 1000,
      slotDate: '2026-06-23', // 8 days after the near line
    })
    const out = compute({
      lines: [near, far],
      amountPaid: 1000,
      nowEpoch: hoursBefore(20),
    })
    expect(out.lines.map((l) => l.retention)).toEqual([300, 0])
    expect(out.grossRetention).toBe(300)
    expect(out.refund).toBe(700)
    expect(out.keptCommission).toBe(60)
    expect(out.reversedCommission).toBe(40)
  })
})

// ---------------------------------------------------------------------------
// D7 — a delivered line retains everything
// ---------------------------------------------------------------------------
describe('redeemed lines (D7)', () => {
  it('a redeemed line retains its whole total, skipping the ladder', () => {
    const used = tourLine({ id: 'a', lineTotal: 500, redeemedCount: 1 })
    const unused = tourLine({ id: 'b', lineTotal: 500 })
    const out = compute({ lines: [used, unused], amountPaid: 1000, nowEpoch: hoursBefore(20) })
    expect(out.lines[0]!.retention).toBe(500) // full, despite a 50% tier
    expect(out.lines[1]!.retention).toBe(250)
    expect(out.refund).toBe(250)
  })

  it('a redeemed line retains even under a 100%-refund tier', () => {
    const out = compute({
      lines: [tourLine({ redeemedCount: 1 })],
      nowEpoch: hoursBefore(200),
    })
    expect(out.refund).toBe(0)
    expect(out.retention).toBe(100_000)
  })
})

// ---------------------------------------------------------------------------
// D3 — retention-first, so partial payments and deposits fall out with no special case
// ---------------------------------------------------------------------------
describe('retention over the total, refund from what was paid (D3)', () => {
  it('refunds nothing when the retention exceeds what was collected — and never goes negative', () => {
    // Total 1000, only 300 collected, same-day tier retains 500 on paper.
    const out = compute({
      lines: [tourLine({ lineTotal: 1000 })],
      amountPaid: 300,
      nowEpoch: hoursBefore(20),
    })
    expect(out.grossRetention).toBe(500) // what the ladder said
    expect(out.refund).toBe(0)
    expect(out.retention).toBe(300) // capped at what actually exists
  })

  it('refund + retention always equals what was paid', () => {
    for (const hours of [200, 120, 100, 20, 1, -5]) {
      const out = compute({ nowEpoch: hoursBefore(hours) })
      expect(out.refund + out.retention).toBe(100_000)
    }
  })

  it('a fully unpaid folio refunds nothing without going negative', () => {
    const out = compute({ amountPaid: 0, nowEpoch: hoursBefore(20) })
    expect(out.refund).toBe(0)
    expect(out.retention).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// D20 — an apartado is priced by the ladder, exactly like a paid sale
//
// There used to be a `booking_deposit_retained_pct` floor here that pinned an apartado's refund to
// 0 whatever the ladder said. It is gone, and so is the engine's knowledge that apartados exist:
// `amountPaid` is the only thing that distinguishes one. These cases pin that down — most of them
// pass a deposit of 300 against a 1000 sale and let the arithmetic decide.
// ---------------------------------------------------------------------------
describe('apartados follow the ladder (D20)', () => {
  const apartado = (over: Parameters<typeof compute>[0] = {}) =>
    compute({ amountPaid: 300, lines: [tourLine({ lineTotal: 1000 })], ...over })

  it('refunds the whole deposit under a full-refund tier', () => {
    const out = apartado({ nowEpoch: hoursBefore(200) })
    expect(out.refund).toBe(300) // retention is 0, so every peso collected goes back
    expect(out.retention).toBe(0)
  })

  it('refunds nothing when the retention exceeds the deposit — with no rule about deposits', () => {
    // 50% of a 1000 sale is 500; the customer only ever paid 300, so there is nothing left over.
    const out = apartado({ nowEpoch: hoursBefore(20) })
    expect(out.grossRetention).toBe(500)
    expect(out.refund).toBe(0)
    expect(out.retention).toBe(300) // capped by what was actually collected, never 500
  })

  it('never pursues the customer for the shortfall', () => {
    const out = apartado({ nowEpoch: departureEpoch + 3600 }) // no-show: the ladder retains 1000
    expect(out.refund).toBe(0)
    expect(out.retention).toBe(300)
  })

  it('prices a deposit and a full payment by the SAME rule at the same tier', () => {
    // The identity D20 asserts: one ladder, one arithmetic. The 50% tier retains 500 of the sale in
    // both cases — what differs is only how much money there was to take it from.
    const at = (amountPaid: number) =>
      compute({ amountPaid, lines: [tourLine({ lineTotal: 1000 })], nowEpoch: hoursBefore(20) })
    expect(at(1000)).toMatchObject({ grossRetention: 500, retention: 500, refund: 500 })
    expect(at(300)).toMatchObject({ grossRetention: 500, retention: 300, refund: 0 })
  })
})

// ---------------------------------------------------------------------------
// Commission: the D8 cap, and the D12 affiliate split
// ---------------------------------------------------------------------------
describe('commission', () => {
  it('percent commission mirrors the sale (basis points of the line total)', () => {
    const out = compute({ nowEpoch: hoursBefore(20) })
    expect(out.totalCommission).toBe(10_000) // 10% of 100_000
  })

  it('fixed commission is per spot', () => {
    const out = compute({
      lines: [tourLine({ commissionType: 'fixed', commissionValue: 2_000, quantity: 3 })],
      nowEpoch: hoursBefore(20),
    })
    expect(out.totalCommission).toBe(6_000)
  })

  it('D8 — a full-refund tier that keeps commission still pays nothing (nothing was retained)', () => {
    const generous = cancellationPolicySchema.parse({
      version: 1,
      tiers: [
        { min_hours: 0, refund_pct: 100, agent_commission_pct: 100 },
        { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
      ],
      booking_deposit_retained_pct: 100,
    })
    const out = compute({ policy: generous, nowEpoch: hoursBefore(20) })
    expect(out.refund).toBe(100_000)
    expect(out.keptCommission).toBe(0) // the company never ends a cancellation out of pocket
    expect(out.reversedCommission).toBe(10_000)
  })

  it('D8 — the cap binds against the REAL retention, not the ladder’s paper figure', () => {
    // Ladder retains 500 of a 1000 sale, but only 100 was ever collected: at most 100 can be kept.
    const out = compute({
      lines: [tourLine({ lineTotal: 1000, commissionValue: 10_000 })], // 100% commission = 1000
      amountPaid: 100,
      nowEpoch: hoursBefore(20),
    })
    expect(out.retention).toBe(100)
    expect(out.keptCommission).toBe(100)
    expect(out.reversedCommission).toBe(900)
  })

  it('a partial percentage keeps that share', () => {
    const half = cancellationPolicySchema.parse({
      version: 1,
      tiers: [
        { min_hours: 0, refund_pct: 50, agent_commission_pct: 50 },
        { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
      ],
      booking_deposit_retained_pct: 100,
    })
    const out = compute({ policy: half, nowEpoch: hoursBefore(20) })
    expect(out.keptCommission).toBe(5_000)
    expect(out.reversedCommission).toBe(5_000)
  })

  describe('US-A72 / D12 — the affiliate split', () => {
    const split = cancellationPolicySchema.parse({
      version: 1,
      tiers: [
        { min_hours: 0, refund_pct: 50, agent_commission_pct: 100, affiliate_commission_pct: 50 },
        { min_hours: null, refund_pct: 0, agent_commission_pct: 100, affiliate_commission_pct: 100 },
      ],
      booking_deposit_retained_pct: 100,
    })

    it('pays an in-house agent and a reseller differently on the SAME tier', () => {
      const asAgent = compute({ policy: split, nowEpoch: hoursBefore(20), sellerKind: 'agent' })
      const asAffiliate = compute({
        policy: split,
        nowEpoch: hoursBefore(20),
        sellerKind: 'affiliate',
      })
      expect(asAgent.keptCommission).toBe(10_000)
      expect(asAgent.reversedCommission).toBe(0)
      expect(asAffiliate.keptCommission).toBe(5_000)
      expect(asAffiliate.reversedCommission).toBe(5_000)
      // The split touches commission only — the customer's money is identical.
      expect(asAgent.refund).toBe(asAffiliate.refund)
    })

    it('falls back to the agent percentage when the affiliate one is absent', () => {
      // LADDER has no affiliate_commission_pct at all — a policy written before US-A72.
      const asAgent = compute({ nowEpoch: hoursBefore(20), sellerKind: 'agent' })
      const asAffiliate = compute({ nowEpoch: hoursBefore(20), sellerKind: 'affiliate' })
      expect(asAffiliate.keptCommission).toBe(asAgent.keptCommission)
    })

    it('the D8 cap applies to affiliates too', () => {
      const generous = cancellationPolicySchema.parse({
        version: 1,
        tiers: [
          { min_hours: 0, refund_pct: 100, agent_commission_pct: 0, affiliate_commission_pct: 100 },
          { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
        ],
        booking_deposit_retained_pct: 100,
      })
      const out = compute({ policy: generous, nowEpoch: hoursBefore(20), sellerKind: 'affiliate' })
      expect(out.keptCommission).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------
describe('rounding', () => {
  it('floors retention (the rounding favours the customer)', () => {
    // 333 × 50% = 166.5 → retain 166, refund 167.
    const out = compute({
      lines: [tourLine({ lineTotal: 333 })],
      amountPaid: 333,
      nowEpoch: hoursBefore(20),
    })
    expect(out.retention).toBe(166)
    expect(out.refund).toBe(167)
  })

  it('never invents or loses a unit across many lines', () => {
    const lines = [101, 103, 107, 109].map((total, i) =>
      tourLine({ id: `l${i}`, lineTotal: total }),
    )
    const paid = 101 + 103 + 107 + 109
    const out = compute({ lines, amountPaid: paid, nowEpoch: hoursBefore(20) })
    expect(out.refund + out.retention).toBe(paid)
  })
})

// ---------------------------------------------------------------------------
// The policy document: validation and resolution
// ---------------------------------------------------------------------------
describe('policy validation', () => {
  const base = {
    version: 1,
    tiers: [
      { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
      { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
    ],
  }

  it('accepts a well-formed ladder', () => {
    expect(cancellationPolicySchema.parse(base).tiers).toHaveLength(2)
  })

  // D20 — a document written before the deposit floor was removed must still parse. Zod strips the
  // unknown key on a non-strict object, which is what lets stored org policies and folio snapshots
  // survive the change with no version bump and no rewrite.
  it('parses a legacy document carrying booking_deposit_retained_pct, ignoring it', () => {
    const parsed = cancellationPolicySchema.parse({ ...base, booking_deposit_retained_pct: 100 })
    expect(parsed).not.toHaveProperty('booking_deposit_retained_pct')
    expect(parsed.tiers).toHaveLength(2)
  })

  it('rejects a ladder with no terminal tier', () => {
    const bad = { ...base, tiers: [{ min_hours: 120, refund_pct: 100, agent_commission_pct: 0 }] }
    expect(cancellationPolicySchema.safeParse(bad).success).toBe(false)
  })

  it('rejects two terminal tiers', () => {
    const bad = {
      ...base,
      tiers: [
        { min_hours: null, refund_pct: 100, agent_commission_pct: 0 },
        { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
      ],
    }
    expect(cancellationPolicySchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a terminal tier that is not last', () => {
    const bad = {
      ...base,
      tiers: [
        { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
        { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
      ],
    }
    expect(cancellationPolicySchema.safeParse(bad).success).toBe(false)
  })

  it('rejects ascending or duplicate thresholds (ambiguous / unreachable tiers)', () => {
    const ascending = {
      ...base,
      tiers: [
        { min_hours: 24, refund_pct: 50, agent_commission_pct: 0 },
        { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
        { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
      ],
    }
    const duplicate = {
      ...base,
      tiers: [
        { min_hours: 24, refund_pct: 50, agent_commission_pct: 0 },
        { min_hours: 24, refund_pct: 100, agent_commission_pct: 0 },
        { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
      ],
    }
    expect(cancellationPolicySchema.safeParse(ascending).success).toBe(false)
    expect(cancellationPolicySchema.safeParse(duplicate).success).toBe(false)
  })

  it('rejects out-of-range percentages and empty or oversized ladders', () => {
    const cases = [
      { ...base, tiers: [{ min_hours: null, refund_pct: 101, agent_commission_pct: 0 }] },
      { ...base, tiers: [{ min_hours: null, refund_pct: 0, agent_commission_pct: -1 }] },
      { ...base, tiers: [] },
      {
        ...base,
        tiers: Array.from({ length: 11 }, (_, i) => ({
          min_hours: 100 - i,
          refund_pct: 0,
          agent_commission_pct: 0,
        })),
      },
    ]
    for (const bad of cases) {
      expect(cancellationPolicySchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('parse and resolve', () => {
  const serialized = JSON.stringify(LADDER)

  it('returns null for absent, malformed, or invalid stored policy', () => {
    expect(parseCancellationPolicy(null)).toBeNull()
    expect(parseCancellationPolicy('')).toBeNull()
    expect(parseCancellationPolicy('{ not json')).toBeNull()
    expect(parseCancellationPolicy('{"version":1,"tiers":[]}')).toBeNull()
  })

  it('parses a stored ladder', () => {
    expect(parseCancellationPolicy(serialized)?.tiers).toHaveLength(3)
  })

  it('D6 — the folio snapshot wins over the org policy', () => {
    const orgPolicy = JSON.stringify(
      cancellationPolicySchema.parse({
        version: 1,
        tiers: [{ min_hours: null, refund_pct: 0, agent_commission_pct: 0 }],
      }),
    )
    expect(resolvePolicy(serialized, orgPolicy)?.tiers).toHaveLength(3)
  })

  it('falls back to the org policy when the folio has no snapshot', () => {
    expect(resolvePolicy(null, serialized)?.tiers).toHaveLength(3)
  })

  it('a folio with an unparseable snapshot falls back rather than failing', () => {
    expect(resolvePolicy('{ broken', serialized)?.tiers).toHaveLength(3)
  })

  // D17 — replaces the Phase-1 assertion that this returned null (the data gate). There is no
  // legacy path left to fall back to, so a folio must always be priceable; reaching this constant
  // means a row escaped both the 0054 backfill and organization creation.
  it('falls back to the module default when neither exists — never null', () => {
    const resolved = resolvePolicy(null, null)
    expect(resolved).toEqual(DEFAULT_CANCELLATION_POLICY)
    expect(resolved.tiers).toEqual([
      { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
      { min_hours: 24, refund_pct: 50, agent_commission_pct: 100 },
      { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
    ])
  })

  // D18 revised — the inherited ladder is no longer a flat 100%. It used to be, on the reasoning
  // that unstated terms should be read the customer's way; that stopped being safe once the same
  // ladder started pricing apartados (D20), because it handed back every deposit to every no-show.
  it('the inherited default steps down as the departure approaches', () => {
    const at = (hours: number) =>
      compute({ policy: DEFAULT_CANCELLATION_POLICY, nowEpoch: hoursBefore(hours) })

    // Five days or more out: everything back, and the seller earns nothing on a sale that is undone
    // (D19 — with nothing retained, the D8 cap necessarily zeroes the kept commission).
    expect(at(500)).toMatchObject({ refund: 100_000, retention: 0, keptCommission: 0 })
    expect(at(120)).toMatchObject({ refund: 100_000, keptCommission: 0 }) // inclusive boundary
    expect(at(120).reversedCommission).toBe(10_000)

    // Inside five days: half. The seller keeps their commission, capped by what was retained.
    expect(at(119)).toMatchObject({ refund: 50_000, retention: 50_000, keptCommission: 10_000 })
    expect(at(24)).toMatchObject({ refund: 50_000 }) // inclusive boundary

    // Departed — a no-show recovers nothing.
    expect(at(-50)).toMatchObject({ refund: 0, retention: 100_000, keptCommission: 10_000 })
  })

  it('the default prices an apartado by those same tiers (D20)', () => {
    const apartado = (hours: number) =>
      compute({
        policy: DEFAULT_CANCELLATION_POLICY,
        amountPaid: 30_000,
        nowEpoch: hoursBefore(hours),
      })
    // Far out the deposit comes back in full; inside the 50% tier the retention (50,000) already
    // exceeds it, so nothing is left. No deposit clause is involved in either answer.
    expect(apartado(200).refund).toBe(30_000)
    expect(apartado(20).refund).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The ledger split (spec Rule 8) — how a PARTIAL refund is spread across the methods the
// customer actually paid with. Pure: the DB-level assertions live with the handler tests.
//
// The invariant that matters is exactness. The ledger is the cash engine's source of truth, so a
// stray minor unit here is a corte that does not reconcile.
// ---------------------------------------------------------------------------
describe('prorateAcrossBuckets', () => {
  const buckets = (...pairs: Array<[string, number]>) =>
    pairs.map(([method, amount]) => ({ method: method as never, amount }))

  it('splits in proportion to what each method collected', () => {
    const out = prorateAcrossBuckets(buckets(['cash', 300], ['transfer', 700]), 500)
    expect(out).toEqual([
      { method: 'cash', amount: 150 },
      { method: 'transfer', amount: 350 },
    ])
  })

  it('sums to the target EXACTLY, remainder to the largest bucket', () => {
    const out = prorateAcrossBuckets(buckets(['cash', 333], ['transfer', 667]), 500)
    expect(out.reduce((s, r) => s + r.amount, 0)).toBe(500)
    // 333×500/1000 = 166.5 → floor 166; 667×500/1000 = 333.5 → floor 333; remainder 1 → transfer.
    expect(out).toEqual([
      { method: 'cash', amount: 166 },
      { method: 'transfer', amount: 334 },
    ])
  })

  it('is exact across many awkward splits', () => {
    for (const target of [1, 7, 99, 101, 500, 999]) {
      const out = prorateAcrossBuckets(buckets(['cash', 333], ['transfer', 667]), target)
      expect(out.reduce((s, r) => s + r.amount, 0)).toBe(target)
    }
  })

  it('never pushes a bucket negative — no share exceeds what that method holds', () => {
    const out = prorateAcrossBuckets(buckets(['cash', 100], ['transfer', 900]), 950)
    const cash = out.find((r) => r.method === 'cash')!
    expect(cash.amount).toBeLessThanOrEqual(100)
    expect(out.reduce((s, r) => s + r.amount, 0)).toBe(950)
  })

  it('clamps a target larger than the total instead of inventing money', () => {
    const out = prorateAcrossBuckets(buckets(['cash', 300]), 5_000)
    expect(out).toEqual([{ method: 'cash', amount: 300 }])
  })

  it('reverses everything when the target IS the total', () => {
    const out = prorateAcrossBuckets(buckets(['cash', 300], ['transfer', 700]), 1000)
    expect(out).toEqual([
      { method: 'cash', amount: 300 },
      { method: 'transfer', amount: 700 },
    ])
  })

  it('emits nothing for a zero target, and skips zero and negative buckets', () => {
    expect(prorateAcrossBuckets(buckets(['cash', 300]), 0)).toEqual([])
    expect(prorateAcrossBuckets(buckets(['cash', 0], ['transfer', 700]), 700)).toEqual([
      { method: 'transfer', amount: 700 },
    ])
    // An already fully-refunded bucket is net-negative and must not receive a share.
    expect(prorateAcrossBuckets(buckets(['cash', -100], ['transfer', 700]), 350)).toEqual([
      { method: 'transfer', amount: 350 },
    ])
  })

  it('is deterministic when buckets tie', () => {
    const a = prorateAcrossBuckets(buckets(['cash', 500], ['transfer', 500]), 999)
    const b = prorateAcrossBuckets(buckets(['cash', 500], ['transfer', 500]), 999)
    expect(a).toEqual(b)
    expect(a.reduce((s, r) => s + r.amount, 0)).toBe(999)
  })
})
