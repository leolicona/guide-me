// Cancellation Policy Engine — the org's refund ladder.
// Spec: docs/cancellation/cancellation-policy-engine.spec.md
//
// Shapes mirror the server document exactly (snake_case), because the whole object is round-tripped
// through PUT /api/organizations/me and validated there as a unit. Keeping the client shape
// identical means there is no mapping layer to drift.

export interface CancellationTier {
  /**
   * HOURS before departure this tier starts applying; `null` is the terminal tier — the one that
   * applies after departure (a no-show). Always hours, never days (D16): "5 días" and "120 horas"
   * are different promises at the boundary, and a converting UI would promise refunds the engine
   * does not give.
   */
  min_hours: number | null
  /** 0–100. Share of the LINE's total the customer gets back. The company retains the rest. */
  refund_pct: number
  /** 0–100. Share of the line's commission an in-house agent keeps (capped by what was retained). */
  agent_commission_pct: number
  /** 0–100. Same, for an affiliate reseller. Omitted ⇒ affiliates are treated like agents. */
  affiliate_commission_pct?: number
}

export interface CancellationPolicy {
  version: 1
  /** Ordered highest `min_hours` first, with exactly one terminal (`null`) tier last. */
  tiers: CancellationTier[]
  /** 0–100. Floor for an unsettled booking; 100 (default) = the deposit is never refunded. */
  booking_deposit_retained_pct: number
}

// What cancelling a folio RIGHT NOW would cost. Read-only: the server computes it with the same
// function the cancel endpoint uses, so the number shown is the number that will be written.
// `null` when the folio has no policy or is already cancelled.
export interface CancellationQuoteLine {
  line_id: string
  /** Hours until this line departs; `null` when its departure could not be read. */
  hours_out: number | null
  refund_pct: number
  retention: number
  /** Already scanned — it retains its whole total regardless of the ladder (D7). */
  redeemed: boolean
}

export interface CancellationQuote {
  refund: number
  retention: number
  kept_commission: number
  reversed_commission: number
  lines: CancellationQuoteLine[]
}

// A sensible starting ladder for an org configuring one for the first time: full refund with five
// days' notice, half inside that, nothing after departure. Commission mirrors it — nothing earned
// on an early cancellation, kept once the company retained something.
//
// This MUST mirror `DEFAULT_CANCELLATION_POLICY` in the API (`utils/cancellationPolicy.ts`): it is
// what migration 0054 wrote into every organization and what a new one is created with. The client
// copy exists so "restablecer" can write the same document the server would, rather than clearing
// the field and hoping the fallback matches.
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  version: 1,
  tiers: [{ min_hours: null, refund_pct: 100, agent_commission_pct: 0 }],
  booking_deposit_retained_pct: 100,
}

// A worked example an admin can start from — the spec's ladder. Offered as a suggestion, never
// applied silently: an inherited policy is the flat 100% above, not this.
export const EXAMPLE_CANCELLATION_LADDER: CancellationPolicy = {
  version: 1,
  tiers: [
    { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
    { min_hours: 24, refund_pct: 50, agent_commission_pct: 100 },
    { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
  ],
  booking_deposit_retained_pct: 100,
}
