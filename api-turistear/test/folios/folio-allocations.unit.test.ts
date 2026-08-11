import { describe, it, expect } from 'vitest'
import {
  allocateFull,
  bookingSegments,
  orderForCascade,
  prorateByWeight,
  seedAndCascade,
  splitRows,
  assertAllocations,
} from '../../src/utils/folioAllocations'

// US-LG09 — the pure allocation engine (docs/folios/line-autonomy.spec.md D1–D3).
// These are the arithmetic assertions the backfill oracle (S-16) and the endpoint tests build on;
// everything here is pure — no db, no clock.

const tue = { id: 'line-tue', lineTotal: 100_000, slotDate: '2026-08-18', slotStartTime: '09:00' }
const thu = { id: 'line-thu', lineTotal: 50_000, slotDate: '2026-08-20', slotStartTime: '07:30' }
const stay = { id: 'line-stay', lineTotal: 80_000, checkIn: '2026-08-19' }

describe('orderForCascade (D3)', () => {
  it('orders by naive departure — a stay by its check-in midnight — with legacy lines last', () => {
    const legacy = { id: 'line-legacy', lineTotal: 10_000 }
    expect(orderForCascade([legacy, thu, stay, tue]).map((l) => l.id)).toEqual([
      'line-tue', // 18th 09:00
      'line-stay', // 19th 00:00
      'line-thu', // 20th 07:30
      'line-legacy', // no readable departure → last
    ])
  })

  it('breaks a same-instant tie by line id, deterministically', () => {
    const a = { id: 'b-line', lineTotal: 1000, slotDate: '2026-08-18', slotStartTime: '09:00' }
    const b = { id: 'a-line', lineTotal: 2000, slotDate: '2026-08-18', slotStartTime: '09:00' }
    expect(orderForCascade([a, b]).map((l) => l.id)).toEqual(['a-line', 'b-line'])
  })
})

describe('allocateFull (S-1)', () => {
  it('funds every line at exactly line_total', () => {
    expect(allocateFull([thu, tue])).toEqual([
      { folioLineId: 'line-tue', amount: 100_000 },
      { folioLineId: 'line-thu', amount: 50_000 },
    ])
  })
})

describe('seedAndCascade (S-2 / S-3)', () => {
  it('S-2 — seeds each line at the org minimum, surplus tops up the soonest departure', () => {
    // $1,000 (Tue) + $500 (Thu), min 30%, deposit $600 → seeds 300/150, surplus 150 → Tue.
    expect(seedAndCascade([tue, thu], 30, 60_000)).toEqual([
      { folioLineId: 'line-tue', amount: 45_000 },
      { folioLineId: 'line-thu', amount: 15_000 },
    ])
  })

  it('S-3 — the cascade crosses a line into fully-funded, the sibling keeps only its seed', () => {
    expect(seedAndCascade([tue, thu], 30, 115_000)).toEqual([
      { folioLineId: 'line-tue', amount: 100_000 },
      { folioLineId: 'line-thu', amount: 15_000 },
    ])
  })

  it('a deposit equal to the total funds everything (degenerate full payment)', () => {
    expect(seedAndCascade([tue, thu], 30, 150_000)).toEqual([
      { folioLineId: 'line-tue', amount: 100_000 },
      { folioLineId: 'line-thu', amount: 50_000 },
    ])
  })

  it('a deposit below Σ seeds fills seeds in cascade order (the backfill degenerate case)', () => {
    // Backfill reality: an old deposit taken under a smaller historical min %. Seeds are 300/150;
    // $350 covers Tue's seed and only $50 of Thu's.
    expect(seedAndCascade([tue, thu], 30, 35_000)).toEqual([
      { folioLineId: 'line-tue', amount: 30_000 },
      { folioLineId: 'line-thu', amount: 5_000 },
    ])
  })

  it('odd cents: seeds floor, so Σ seeds never exceeds the folio minimum already enforced', () => {
    const a = { id: 'a', lineTotal: 3_333, slotDate: '2026-08-18', slotStartTime: '08:00' }
    const b = { id: 'b', lineTotal: 6_667, slotDate: '2026-08-19', slotStartTime: '08:00' }
    // floor(3333×30%)=999 · floor(6667×30%)=2000 — Σ 2999 ≤ ceil(10000×30%)=3000 = min deposit.
    const allocs = seedAndCascade([a, b], 30, 3_000)
    expect(allocs).toEqual([
      { folioLineId: 'a', amount: 1_000 }, // seed 999 + 1 surplus cascaded to the earliest
      { folioLineId: 'b', amount: 2_000 },
    ])
    expect(allocs.reduce((s, x) => s + x.amount, 0)).toBe(3_000)
  })
})

describe('splitRows — many payments over the same segments (the backfill shape)', () => {
  it('deposit + settle over booking segments reproduce seed-then-cascade per row', () => {
    const segments = bookingSegments([tue, thu], 30)
    const [deposit, settle] = splitRows(segments, [60_000, 90_000])
    expect(deposit).toEqual([
      { folioLineId: 'line-tue', amount: 45_000 },
      { folioLineId: 'line-thu', amount: 15_000 },
    ])
    // The settle finishes Tue (55k) then Thu (35k); Σ per line = line_total exactly.
    expect(settle).toEqual([
      { folioLineId: 'line-tue', amount: 55_000 },
      { folioLineId: 'line-thu', amount: 35_000 },
    ])
  })

  it('a row crossing a line boundary lands merged, one allocation per (row, line)', () => {
    const rows = splitRows(allocateFull([tue, thu]), [120_000, 30_000])
    expect(rows[0]).toEqual([
      { folioLineId: 'line-tue', amount: 100_000 },
      { folioLineId: 'line-thu', amount: 20_000 },
    ])
    expect(rows[1]).toEqual([{ folioLineId: 'line-thu', amount: 30_000 }])
  })

  it('money exceeding the segments throws ALLOCATION_MISMATCH — never a silent partial', () => {
    expect(() => splitRows(allocateFull([thu]), [50_001])).toThrowError(/allocate/i)
  })
})

describe('prorateByWeight (the refund shares)', () => {
  it('floors each share and hands the remainder to the heaviest line, Σ exact', () => {
    const shares = prorateByWeight(
      [
        { folioLineId: 'line-tue', weight: 45_000 },
        { folioLineId: 'line-thu', weight: 15_000 },
      ],
      10_001,
    )
    expect(shares.reduce((s, x) => s + x.amount, 0)).toBe(10_001)
    expect(shares).toEqual([
      { folioLineId: 'line-tue', amount: 7_501 }, // floor 7500 + the remainder unit
      { folioLineId: 'line-thu', amount: 2_500 },
    ])
  })

  it('clamps to the total weight and drops zero shares', () => {
    expect(prorateByWeight([{ folioLineId: 'x', weight: 500 }], 900)).toEqual([
      { folioLineId: 'x', amount: 500 },
    ])
    expect(prorateByWeight([], 900)).toEqual([])
  })
})

describe('assertAllocations (rule 1)', () => {
  it('accepts an exact cover and rejects gaps, overshoot and zero rows', () => {
    expect(() =>
      assertAllocations(100, [{ folioLineId: 'x', amount: 100 }]),
    ).not.toThrow()
    expect(() => assertAllocations(-100, [{ folioLineId: 'x', amount: 100 }])).not.toThrow()
    expect(() => assertAllocations(100, [{ folioLineId: 'x', amount: 99 }])).toThrow()
    expect(() => assertAllocations(100, [{ folioLineId: 'x', amount: 101 }])).toThrow()
    expect(() =>
      assertAllocations(100, [
        { folioLineId: 'x', amount: 100 },
        { folioLineId: 'y', amount: 0 },
      ]),
    ).toThrow()
  })
})
