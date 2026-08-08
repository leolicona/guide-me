import { departureEpoch, type PolicyLine } from './cancellationPolicy'

// The folio's SIXTH axis — whether what was sold was actually used.
// Spec: docs/folios/folio-state-machine.spec.md (US-A85, D1–D7, D23–D24).
//
// Read this file knowing one thing: **nothing here is stored.** `folio_lines.redeemed_count` is the
// only authority, and everything below is a reading of it against the line's own snapshotted
// departure. There is no column, no cron, and no writer (D4) — which is why a passenger who boards
// after the margin simply gets scanned and stops being a no-show (D5). There is no state to revert,
// because no state was written. This is `apartado-stages.spec.md` S7 applied a second time: a
// stored stage needs a writer, and a cron that writes state drifts from the clock that defines it.

export type Fulfillment = 'pending' | 'partial' | 'fulfilled' | 'no_show'

/** What a line needs to be read. A subset of `PolicyLine` plus the two counts. */
export interface FulfillmentLine extends PolicyLine {
  quantity: number
  redeemedCount: number
}

/**
 * One line's reading.
 *
 * `marginMinutes` is the ORGANIZATION's `no_show_margin_minutes` (D23), signed like its neighbours:
 * positive = before departure, negative = after. It is deliberately **not**
 * `booking_grace_offset_minutes` (which fixes `booking_expires_at` and fires the apartado's
 * auto-cancellation) and **not** `sales_cutoff_offset_minutes` (which gates the sale) — one number
 * cannot serve two intents.
 *
 * `nowEpoch` is an argument, never a clock read in here: the same discipline the cancellation
 * engine keeps, so the whole axis is exhaustively testable without seeding a folio.
 */
export const lineFulfillment = (
  line: FulfillmentLine,
  tz: string,
  marginMinutes: number,
  nowEpoch: number,
): Fulfillment => {
  if (line.redeemedCount >= line.quantity) return 'fulfilled'
  if (line.redeemedCount > 0) return 'partial'

  const departed = departureEpoch(line, tz)
  // A line with no readable departure (a legacy row with a null slot_date) stays `pending` — the
  // OPPOSITE of the cancellation engine's conservative direction, and deliberately so. The engine's
  // caution protects money; here the cautious direction is to not accuse a customer of failing to
  // show up on the strength of a column that is missing.
  if (departed === null) return 'pending'

  return nowEpoch > departed - marginMinutes * 60 ? 'no_show' : 'pending'
}

// D7 — the worst case wins, and `fulfilled` ranks LAST on purpose: a folio is consumed only when
// there is nothing left to consume. Ordering it above `pending` would label a folio "Consumido"
// while one of its tours has not departed — and a folio that reads "Consumido" is a folio nobody
// opens, which is exactly how a wasted seat stays hidden.
const RANK: Record<Fulfillment, number> = { no_show: 0, partial: 1, pending: 2, fulfilled: 3 }

/** The folio's roll-up. An empty folio has nothing outstanding, so it reads `fulfilled`. */
export const folioFulfillment = (lines: Fulfillment[]): Fulfillment =>
  lines.reduce<Fulfillment>((worst, f) => (RANK[f] < RANK[worst] ? f : worst), 'fulfilled')

/**
 * D24 — what a wasted-seat count can actually distinguish, given how this org's gate consumes a
 * ticket. Under `all_passes` one scan sets `redeemed_count = quantity`, so `partial` is unreachable
 * and a party of four where two boarded reads `fulfilled`. That is a gate-throughput choice with a
 * cost, and the cost is exactly the data this axis produces — so every surface that reports it must
 * say which question it is answering.
 */
export const fulfillmentResolution = (mode: 'per_pass' | 'all_passes'): 'per_seat' | 'per_party' =>
  mode === 'all_passes' ? 'per_party' : 'per_seat'
