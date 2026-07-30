import { z } from 'zod'
import { naiveEpoch } from './tz'

// Cancellation Policy Engine — the PURE core.
// Spec: docs/cancellation/cancellation-policy-engine.spec.md
//
// No database, no clock of its own, no I/O: callers pass the folio's lines, what was collected,
// and "now". That is deliberate — the arithmetic here decides how much money goes back to a
// customer and how much commission an agent forfeits, so it must be exhaustively testable without
// seeding a folio.
//
// The one thing to keep in mind reading this file: the ladder is written in terms of what is
// REFUNDED, but the engine works in terms of what the company RETAINS (D3). That inversion is what
// makes a partly-paid folio fall out correctly with no special case — see `computeCancellationRefund`.

// --- The policy document ---------------------------------------------------

// A tier matches when the line's departure is at least `min_hours` away. `min_hours: null` is the
// terminal catch-all — a departure already past (a no-show).
const tierSchema = z.object({
  min_hours: z.number().int().min(0).nullable(),
  refund_pct: z.number().int().min(0).max(100),
  // Share of the line's commission an IN-HOUSE agent keeps (before the D8 cap).
  agent_commission_pct: z.number().int().min(0).max(100),
  // US-A72 (D12) — same, for a sale made by an affiliate reseller. OPTIONAL: when absent the
  // affiliate is treated exactly like an in-house agent, so a policy written (or snapshotted onto a
  // folio) before this field existed keeps behaving as it did.
  affiliate_commission_pct: z.number().int().min(0).max(100).optional(),
})

// D20 — the ladder is the WHOLE document. There is no deposit clause, because an apartado is not a
// different kind of sale: it is the same sale with less money collected against it, and D3 already
// prices that correctly. `booking_deposit_retained_pct` used to live here as a floor that pinned an
// apartado's refund to 0 no matter what the ladder said; it is removed, not defaulted to 0, so the
// contradiction cannot be re-introduced by configuration.
//
// Stored documents written before this still carry the key. Zod strips unknown keys on a non-strict
// object, so an org policy or a folio snapshot from the old shape parses cleanly and the stale value
// is simply ignored — no version bump, no snapshot rewrite.
export const cancellationPolicySchema = z
  .object({
    version: z.literal(1),
    tiers: z.array(tierSchema).min(1).max(10),
  })
  .superRefine((policy, ctx) => {
    const terminals = policy.tiers.filter((t) => t.min_hours === null)
    if (terminals.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          'The ladder needs exactly one terminal tier (min_hours: null) — the one that applies after departure',
      })
      return
    }
    if (policy.tiers[policy.tiers.length - 1]!.min_hours !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'The terminal tier (min_hours: null) must be last',
      })
    }
    // Strictly descending: two tiers with the same threshold are ambiguous, and an ascending one is
    // unreachable (the first match wins). Rejecting both means a stored policy is always evaluable.
    const bounded = policy.tiers.filter((t) => t.min_hours !== null).map((t) => t.min_hours!)
    for (let i = 1; i < bounded.length; i++) {
      if (bounded[i]! >= bounded[i - 1]!) {
        ctx.addIssue({
          code: 'custom',
          message: 'Tiers must be ordered by min_hours, highest first, with no duplicates',
        })
        break
      }
    }
  })

export type CancellationPolicy = z.infer<typeof cancellationPolicySchema>
export type CancellationTier = z.infer<typeof tierSchema>

// Parse a STORED policy (an org column or a folio snapshot). Returns null for absent OR malformed
// input rather than throwing: a folio whose snapshot somehow fails to parse must degrade to the
// legacy path, never take down a cancellation (and never abort the expiry sweep — spec Rule 24).
// Writes are validated at the edge by the org settings schema, so this is a backstop, not the gate.
export const parseCancellationPolicy = (raw: string | null | undefined): CancellationPolicy | null => {
  if (!raw) return null
  try {
    const parsed = cancellationPolicySchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// D18 (revised) — the ladder every organization inherits unless it configures its own: full refund
// with five days' notice, half inside that, nothing once the departure has passed.
//
// The first version of this constant refunded 100% unconditionally, on the reasoning that unstated
// terms should be read the way a customer would. That held only while the engine priced fully-paid
// folios — sales an admin was already refunding by hand. Now that it prices apartados too (D20), an
// unconfigured org would hand back every deposit on every cancellation, including to a customer who
// simply never showed up. A default nobody would run is not a safe default; it is a trap that
// happens to be generous. This ladder is the one the spec has always used as its worked example.
//
// Written into every org by migrations 0054/0055 and at organization creation, so it is normally
// read from the database like any other policy. The constant exists so the writers agree on one
// definition — and as the last line of `resolvePolicy` below.
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = Object.freeze({
  version: 1 as const,
  tiers: [
    { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
    { min_hours: 24, refund_pct: 50, agent_commission_pct: 100 },
    { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
  ],
})

// D6 — a folio is priced by the ladder that was in force when it was SOLD; the org's live policy is
// the fallback for folios sold before the feature. This is the ONLY place resolution happens; a
// per-service override (deferred) would slot in here and nowhere else.
//
// D17 — it NEVER returns null. Phase 1 had a null branch that put the caller on a second, legacy
// pricing path; that path is gone, so there is nothing to fall back TO. Reaching the constant means
// a row escaped migration 0054 and organization creation both, which should be impossible — the
// point is that even then a folio stays priceable, with a defined, generous outcome, instead of
// failing to cancel.
export const resolvePolicy = (
  snapshot: string | null | undefined,
  orgPolicy: string | null | undefined,
): CancellationPolicy =>
  parseCancellationPolicy(snapshot) ??
  parseCancellationPolicy(orgPolicy) ??
  DEFAULT_CANCELLATION_POLICY

// --- Inputs ----------------------------------------------------------------

export interface PolicyLine {
  id: string
  lineTotal: number
  quantity: number
  redeemedCount: number
  commissionType: 'percent' | 'fixed'
  commissionValue: number
  lineType: 'slot' | 'stay'
  slotDate: string | null // 'YYYY-MM-DD' — tour lines
  slotStartTime: string | null // 'HH:MM' — tour lines
  checkIn: string | null // 'YYYY-MM-DD' — stay lines
}

export interface ComputeRefundInput {
  policy: CancellationPolicy
  lines: PolicyLine[]
  amountPaid: number
  /** Seconds since epoch. Injected so the engine has no clock of its own. */
  nowEpoch: number
  timezone: string
  /** D12 — decides which of the tier's two commission percentages applies. */
  sellerKind: 'agent' | 'affiliate'
  /**
   * `folios.commission_amount` — the commission actually booked on the sale, which is what the cash
   * engine and the commission report read. Normally it equals the sum re-derived from the lines.
   *
   * It does NOT for folios sold before migration `0028` added `folio_lines.commission_type/value`:
   * those lines default to `0` while the folio still carries its real commission. Without this,
   * cancelling such a folio would silently reverse nothing and the seller would keep commission on
   * a sale that was undone. See `lineCommissions` below for how the shortfall is distributed.
   */
  bookedCommission?: number
}

export interface LineOutcome {
  lineId: string
  /** Hours until this line's departure; negative once it has departed. */
  hoursOut: number
  refundPct: number
  retention: number
  commission: number
  keptCommission: number
  /** True when the line skipped the ladder because it was already delivered (D7). */
  redeemed: boolean
}

export interface CancellationOutcome {
  /** What the customer gets back. Never negative, never more than they paid. */
  refund: number
  /** What the company actually keeps — `amountPaid − refund`, so it can never exceed what was collected. */
  retention: number
  /** What the ladder retained on paper, before the collected-money cap. Diagnostic only. */
  grossRetention: number
  totalCommission: number
  keptCommission: number
  reversedCommission: number
  lines: LineOutcome[]
}

// --- The computation -------------------------------------------------------

// A line's departure as an absolute instant (seconds). Tour lines carry a snapshotted wall-clock
// date + time; stay lines carry a check-in date, read at 00:00 org-local (D11 — lodging has no
// configurable check-in hour, and midnight is the conservative reading: the whole check-in day
// counts as "same day"). Both resolve through the org's zone, never UTC — measuring in calendar
// days against a UTC clock is what made a 3-hours-away slot look like "tomorrow" (see 0052).
const departureEpoch = (line: PolicyLine, tz: string): number | null => {
  if (line.lineType === 'stay') {
    return line.checkIn ? naiveEpoch(line.checkIn, '00:00', tz) : null
  }
  if (!line.slotDate) return null
  return naiveEpoch(line.slotDate, line.slotStartTime ?? '00:00', tz)
}

// First tier whose threshold the line clears; the terminal tier when none do. The schema guarantees
// the tiers are ordered highest-first with exactly one terminal at the end, so a linear scan is the
// whole algorithm.
const matchTier = (policy: CancellationPolicy, hoursOut: number): CancellationTier => {
  for (const tier of policy.tiers) {
    if (tier.min_hours !== null && hoursOut >= tier.min_hours) return tier
  }
  return policy.tiers[policy.tiers.length - 1]!
}

// Mirrors how the sale computed it (pos/handler.ts) so a cancellation never disagrees with the sale
// about what was earned: percent is basis points of the line total, fixed is per spot.
const lineCommission = (line: PolicyLine): number =>
  line.commissionType === 'percent'
    ? Math.round((line.lineTotal * line.commissionValue) / 10000)
    : line.commissionValue * line.quantity

// Each line's commission, reconciled so the per-line values sum to what the folio ACTUALLY booked.
//
// `folios.commission_amount` is authoritative — it is what the cash engine and the commission report
// read — so when it is supplied the lines are redistributed to match it, in either direction:
//
//   * lines carry nothing, folio booked something (a folio sold before `0028` snapshotted commission
//     onto lines): the booked amount is spread in proportion to `line_total`, which is exactly what
//     a percent commission would have produced.
//   * lines carry MORE than the folio booked: an APARTADO. Commission accrues on the amount actually
//     collected (US-AG07), so a 10% commission on a 300,000 sale with a 45,000 deposit booked 4,500
//     — while the lines, which describe the whole sale, still say 30,000. Deriving from the lines
//     reported that the agent forfeited 30,000 of commission they had never earned.
//
// The ledger was never at risk of paying that out (`prorateAcrossBuckets` clamps a reversal to the
// commission rows that exist), but the OUTCOME is shown to a human — "esto es lo que pierdes" on the
// POS — and a figure that is 6× reality is not a rounding concern. Scaling here fixes the number at
// its source, so every reader agrees.
//
// Omitting `bookedCommission` means "no authoritative figure": the lines are used as-is.
const lineCommissions = (lines: PolicyLine[], bookedCommission?: number): number[] => {
  const perLine = lines.map(lineCommission)
  const summed = perLine.reduce((a, b) => a + b, 0)
  if (bookedCommission === undefined || bookedCommission < 0 || summed === bookedCommission) {
    return perLine
  }

  // Spread by whatever signal we have: the per-line commissions when the lines carry any, the line
  // totals when they carry none. Both are proportional to what each line contributed to the sale.
  const weights = summed > 0 ? perLine : lines.map((l) => l.lineTotal)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight <= 0) return perLine

  const shares = weights.map((w) => Math.floor((bookedCommission * w) / totalWeight))
  // Give the flooring remainder to the heaviest line, so the shares sum to the booked amount exactly.
  const remainder = bookedCommission - shares.reduce((a, b) => a + b, 0)
  if (remainder > 0) {
    let biggest = 0
    weights.forEach((w, i) => {
      if (w > weights[biggest]!) biggest = i
    })
    shares[biggest] = shares[biggest]! + remainder
  }
  return shares
}

const commissionPctOf = (tier: CancellationTier, sellerKind: 'agent' | 'affiliate'): number =>
  sellerKind === 'affiliate'
    ? (tier.affiliate_commission_pct ?? tier.agent_commission_pct)
    : tier.agent_commission_pct

// D20 — note what is NOT a parameter: the folio's status. The engine cannot tell an apartado from a
// fully-paid sale, and that is the point. `amountPaid` is the only thing that differs between them.
export const computeCancellationRefund = ({
  policy,
  lines,
  amountPaid,
  nowEpoch,
  timezone,
  sellerKind,
  bookedCommission,
}: ComputeRefundInput): CancellationOutcome => {
  const commissions = lineCommissions(lines, bookedCommission)
  const lineOutcomes: LineOutcome[] = []
  let grossRetention = 0
  let totalCommission = 0
  let keptCommission = 0

  for (const [index, line] of lines.entries()) {
    const departure = departureEpoch(line, timezone)
    // A line with no departure we can read is treated as already departed — the terminal tier. That
    // is the conservative direction: it retains the most, and it cannot silently hand back money on
    // a line whose timing we do not actually know.
    const hoursOut = departure === null ? Number.NEGATIVE_INFINITY : (departure - nowEpoch) / 3600
    const tier = matchTier(policy, hoursOut)

    // D7 — a delivered line skips the ladder and retains its whole total. The service happened.
    const redeemed = line.redeemedCount > 0
    const retention = redeemed
      ? line.lineTotal
      : Math.floor((line.lineTotal * (100 - tier.refund_pct)) / 100)

    const commission = commissions[index]!
    // D8 — never let the seller keep more than the company retained on that line, or a full-refund
    // tier that also pays commission would end the cancellation with the company out of pocket.
    const kept = Math.min(
      Math.floor((commission * commissionPctOf(tier, sellerKind)) / 100),
      retention,
    )

    grossRetention += retention
    totalCommission += commission
    keptCommission += kept
    lineOutcomes.push({
      lineId: line.id,
      hoursOut: departure === null ? Number.NEGATIVE_INFINITY : hoursOut,
      refundPct: redeemed ? 0 : tier.refund_pct,
      retention,
      commission,
      keptCommission: kept,
      redeemed,
    })
  }

  // D3 — the inversion that makes deposits work, and the whole of D20's implementation. The ladder
  // says what the company keeps of the SALE; the customer gets back whatever of their payment is
  // left over. A 30% deposit against a 50% retention refunds nothing — not because deposits have a
  // rule, but because there is nothing left. And the customer is never pursued for the shortfall,
  // because the floor is zero.
  const refund = Math.max(0, amountPaid - grossRetention)

  // What the company can actually keep is bounded by what it actually collected — the ladder may
  // retain 500 on paper while only 300 was ever paid. Deriving it as `paid − refund` keeps the two
  // figures consistent by construction, which is what the ledger reversal relies on.
  const retention = amountPaid - refund

  // The per-line D8 cap used each line's PAPER retention; cap the total by the REAL one too, so an
  // over-retaining ladder on a barely-paid folio still cannot pay out commission that no money backs.
  keptCommission = Math.min(keptCommission, retention)

  return {
    refund,
    retention,
    grossRetention,
    totalCommission,
    keptCommission,
    reversedCommission: totalCommission - keptCommission,
    lines: lineOutcomes,
  }
}
