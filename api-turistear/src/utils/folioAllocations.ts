import { ApiError } from '../types/errors'

// US-LG09 (docs/folios/line-autonomy.spec.md, D1–D3) — the pure allocation engine: which lines a
// payment funds, and by how much. No db, no clock, no I/O — every function here is deterministic
// arithmetic over snapshots, because migration 0062's backfill SQL is verified AGAINST this module
// as an oracle (S-16): the rule exists once, here, and the SQL is proven to match it.
//
// The model is SEGMENTS laid on a number line, intersected with payments laid on the same line:
//   * a PAID sale is one segment per line, full line_total, in cascade order;
//   * a DEPOSIT (D2/D3) is two passes of segments — first every line's SEED (the org minimum %
//     of its line_total, floored), then every line's REMAINDER — both in cascade order, so the
//     seed guarantees every line holds its minimum before any line is topped up.
// A payment covers the next unfilled stretch of segments; `splitRows` is that intersection. One
// payment (the live path) and many payments (the backfill's deposit+settle folios) are the same
// computation.
//
// CASCADE ORDER (D3): earliest departure first. The key is the line's NAIVE local departure
// string — `slot_date`/`slot_start_time` for a tour, `check_in` at 00:00 for a stay — never an
// epoch: all of a folio's lines resolve in one org's time zone, where lexicographic order of
// 'YYYY-MM-DDTHH:MM' equals chronological order, and the SQL mirror can build the identical key
// with COALESCE/concat. A legacy line with no readable departure sorts LAST (it can't be "most
// urgent"), ties break by line id.

export interface AllocatableLine {
  id: string
  lineTotal: number
  slotDate?: string | null
  slotStartTime?: string | null
  checkIn?: string | null
}

export interface LineAllocation {
  folioLineId: string
  amount: number // positive magnitude; the caller signs it like its parent payment row
}

// Must stay byte-equivalent to the SQL expression in 0062:
//   COALESCE(slot_date, check_in, '9999-12-31') || 'T' || COALESCE(slot_start_time, '00:00')
const cascadeKey = (l: AllocatableLine): string =>
  `${l.slotDate ?? l.checkIn ?? '9999-12-31'}T${l.slotStartTime ?? '00:00'}`

export const orderForCascade = <T extends AllocatableLine>(lines: T[]): T[] =>
  [...lines].sort((a, b) => {
    const ka = cascadeKey(a)
    const kb = cascadeKey(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    return a.id < b.id ? -1 : a.id === b.id ? 0 : 1
  })

// A full payment funds every line exactly (S-1). Order is cosmetic here, but keeping cascade
// order means every allocation list this module produces reads the same way.
export const allocateFull = (lines: AllocatableLine[]): LineAllocation[] =>
  orderForCascade(lines)
    .filter((l) => l.lineTotal > 0)
    .map((l) => ({ folioLineId: l.id, amount: l.lineTotal }))

// D2/D3 — the deposit's segment sequence: seeds first (floored, so Σ seeds can never exceed the
// folio minimum the checkout already enforced), then remainders, both in cascade order.
export const bookingSegments = (
  lines: AllocatableLine[],
  minDownPaymentPct: number,
): LineAllocation[] => {
  const ordered = orderForCascade(lines)
  const seeds = ordered.map((l) => ({
    folioLineId: l.id,
    amount: Math.min(l.lineTotal, Math.floor((l.lineTotal * minDownPaymentPct) / 100)),
  }))
  const remainders = ordered.map((l, i) => ({
    folioLineId: l.id,
    amount: l.lineTotal - seeds[i].amount,
  }))
  return [...seeds, ...remainders].filter((s) => s.amount > 0)
}

// Lay `rowAmounts` (chronological payment amounts) over `segments`: each row covers the next
// unfilled stretch. Returns one MERGED allocation list per row (a row crossing a line's seed and
// remainder segments yields one row+line allocation). Throws when the money exceeds the segments —
// on the live path that is a bug worth a 500, never a silent partial write (rule 1).
export const splitRows = (
  segments: LineAllocation[],
  rowAmounts: number[],
): LineAllocation[][] => {
  const capacity = segments.reduce((s, seg) => s + seg.amount, 0)
  const asked = rowAmounts.reduce((s, a) => s + a, 0)
  if (asked > capacity) {
    throw new ApiError(
      'ALLOCATION_MISMATCH',
      500,
      `Cannot allocate ${asked} across lines holding ${capacity}`,
    )
  }
  const result: LineAllocation[][] = []
  let seg = 0
  let usedInSeg = 0
  for (const rowAmount of rowAmounts) {
    const merged = new Map<string, number>()
    let remaining = rowAmount
    while (remaining > 0 && seg < segments.length) {
      const room = segments[seg].amount - usedInSeg
      const take = Math.min(room, remaining)
      if (take > 0) {
        merged.set(segments[seg].folioLineId, (merged.get(segments[seg].folioLineId) ?? 0) + take)
        remaining -= take
        usedInSeg += take
      }
      if (usedInSeg >= segments[seg].amount) {
        seg += 1
        usedInSeg = 0
      }
    }
    result.push([...merged.entries()].map(([folioLineId, amount]) => ({ folioLineId, amount })))
  }
  return result
}

// The live deposit path (S-2/S-3): one payment, seeded then cascaded.
export const seedAndCascade = (
  lines: AllocatableLine[],
  minDownPaymentPct: number,
  amount: number,
): LineAllocation[] => splitRows(bookingSegments(lines, minDownPaymentPct), [amount])[0]

// Distribute `target` across weighted lines proportionally, in whole minor units — floors plus
// the remainder to the heaviest weight (first in the given order on a tie), mirroring
// `prorateAcrossBuckets` in folioPayments.ts so the two split rules read the same. Used for the
// refund's per-line shares (a reversal reduces every line's money in proportion to what it holds).
export const prorateByWeight = (
  weights: Array<{ folioLineId: string; weight: number }>,
  target: number,
): LineAllocation[] => {
  const positive = weights.filter((w) => w.weight > 0)
  const total = positive.reduce((s, w) => s + w.weight, 0)
  const want = Math.max(0, Math.min(target, total))
  if (want === 0 || total === 0) return []

  const shares = positive.map((w) => ({
    folioLineId: w.folioLineId,
    weight: w.weight,
    amount: Math.floor((w.weight * want) / total),
  }))
  const remainder = want - shares.reduce((s, x) => s + x.amount, 0)
  if (remainder > 0) {
    const heaviest = shares.reduce((best, s) => (s.weight > best.weight ? s : best))
    heaviest.amount += remainder
  }
  return shares
    .filter((s) => s.amount > 0)
    .map(({ folioLineId, amount }) => ({ folioLineId, amount }))
}

// Rule 1's write-path guard: a payment row and its allocations land in one batch, and they land
// EQUAL — Σ allocations = the row's magnitude, no zero rows. Called before every batch that
// carries allocations; a mismatch is a 500 (`ALLOCATION_MISMATCH`) and nothing is written.
export const assertAllocations = (rowAmount: number, allocations: LineAllocation[]): void => {
  const sum = allocations.reduce((s, a) => s + a.amount, 0)
  if (sum !== Math.abs(rowAmount) || allocations.some((a) => a.amount <= 0)) {
    throw new ApiError(
      'ALLOCATION_MISMATCH',
      500,
      `Allocations (${sum}) do not cover the payment (${Math.abs(rowAmount)})`,
    )
  }
}
