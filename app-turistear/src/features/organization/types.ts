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

// D20 — the ladder is the whole document. There is no deposit clause: an apartado is the same sale
// with less money collected against it, and the retention arithmetic already prices that. The old
// `booking_deposit_retained_pct` floor is removed rather than defaulted to 0, so no configuration
// can put a ladder and a deposit rule in contradiction again.
export interface CancellationPolicy {
  version: 1
  /** Ordered highest `min_hours` first, with exactly one terminal (`null`) tier last. */
  tiers: CancellationTier[]
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

// The ladder every organization inherits: full refund with five days' notice, half inside that,
// nothing once the departure has passed. Commission mirrors it — nothing earned on an early
// cancellation, kept once the company retained something.
//
// This MUST mirror `DEFAULT_CANCELLATION_POLICY` in the API (`utils/cancellationPolicy.ts`): it is
// what migration 0055 wrote into every organization still on the old default, and what a new one is
// created with. The client copy exists so "restablecer" writes the same document the server would,
// rather than clearing the field and hoping the fallback matches.
//
// It used to be a flat "refund 100%, always" (D18). That changed when the engine started pricing
// apartados too (D20): an inherited policy that refunds every deposit to a no-show is not a
// conservative default, it is a trap. This is the spec's worked ladder, promoted to the default.
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  version: 1,
  tiers: [
    { min_hours: 120, refund_pct: 100, agent_commission_pct: 0 },
    { min_hours: 24, refund_pct: 50, agent_commission_pct: 100 },
    { min_hours: null, refund_pct: 0, agent_commission_pct: 100 },
  ],
}
