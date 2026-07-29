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

export const cancellationPolicySchema = z
  .object({
    version: z.literal(1),
    tiers: z.array(tierSchema).min(1).max(10),
    // Floor for an unsettled `booking` folio. 100 (the default) reproduces "a deposit is never
    // refunded" (US-AG07.4); 0 lets the deposit follow the ladder.
    booking_deposit_retained_pct: z.number().int().min(0).max(100).default(100),
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

// D18 — the ladder every organization inherits unless it configures its own: refund everything,
// always. It is the reading a customer would assume of unstated terms, and it never refunds less
// than the most generous path that existed before the engine.
//
// This is written into every org by migration 0054 and at organization creation, so it is normally
// read from the database like any other policy. The constant exists so the two writers agree on one
// definition — and as the last line of `resolvePolicy` below.
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = Object.freeze({
  version: 1 as const,
  tiers: [{ min_hours: null, refund_pct: 100, agent_commission_pct: 0 }],
  booking_deposit_retained_pct: 100,
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
  /** An unsettled `booking` folio is subject to the deposit floor. */
  folioStatus: 'paid' | 'booking' | 'cancelled'
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

// Each line's commission, reconciled against what the folio actually booked.
//
// Normally the per-line values sum to `bookedCommission` and this returns them untouched. When the
// lines carry NOTHING but the folio booked something — a folio sold before `0028` snapshotted
// commission onto lines — the booked amount is distributed across lines in proportion to
// `line_total`, which is exactly what a percent commission would have produced. Each line then
// matches its own tier as usual, so a pre-`0028` folio is priced by the same rules as any other
// instead of quietly forfeiting nothing.
//
// The lines are NOT trusted over the folio the other way round: if they sum to more than the folio
// booked, they win, because a per-line total that exceeds the snapshot means the snapshot is the
// stale one. The reversal is clamped against the ledger's real commission rows regardless
// (`prorateAcrossBuckets`), so neither direction can reverse money that was never accrued.
const lineCommissions = (lines: PolicyLine[], bookedCommission?: number): number[] => {
  const perLine = lines.map(lineCommission)
  const summed = perLine.reduce((a, b) => a + b, 0)
  if (summed > 0 || !bookedCommission || bookedCommission <= 0) return perLine

  const totalValue = lines.reduce((sum, l) => sum + l.lineTotal, 0)
  if (totalValue <= 0) return perLine
  const shares = lines.map((l) => Math.floor((bookedCommission * l.lineTotal) / totalValue))
  // Give the flooring remainder to the largest line, so the shares sum to the booked amount exactly.
  const remainder = bookedCommission - shares.reduce((a, b) => a + b, 0)
  if (remainder > 0) {
    let biggest = 0
    lines.forEach((l, i) => {
      if (l.lineTotal > lines[biggest]!.lineTotal) biggest = i
    })
    shares[biggest] = shares[biggest]! + remainder
  }
  return shares
}

const commissionPctOf = (tier: CancellationTier, sellerKind: 'agent' | 'affiliate'): number =>
  sellerKind === 'affiliate'
    ? (tier.affiliate_commission_pct ?? tier.agent_commission_pct)
    : tier.agent_commission_pct

export const computeCancellationRefund = ({
  policy,
  lines,
  amountPaid,
  folioStatus,
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

  // D3 — the inversion that makes deposits work. The ladder says what the company keeps of the
  // SALE; the customer gets back whatever of their payment is left over. A 30% deposit against a
  // 50% retention refunds nothing, with no rule about deposits — and the customer is never pursued
  // for the shortfall, because the floor is zero.
  let refund = Math.max(0, amountPaid - grossRetention)

  // An unsettled booking additionally honours the deposit floor. At 100 (the default) this pins the
  // refund to 0, reproducing US-AG07.4 exactly.
  if (folioStatus === 'booking') {
    refund = Math.min(
      refund,
      Math.floor((amountPaid * (100 - policy.booking_deposit_retained_pct)) / 100),
    )
  }

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
