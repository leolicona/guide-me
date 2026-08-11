import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { seedUser, clearTenancyDb } from '../helpers/tenancy'
import {
  allocateFull,
  bookingSegments,
  prorateByWeight,
  seedAndCascade,
  splitRows,
} from '../../src/utils/folioAllocations'
// @ts-expect-error — vite's ?raw import; the test replays the migration's backfill INSERTs (S-15).
import migrationSql from '../../migrations/0062_folio_payment_allocations.sql?raw'

// US-LG09 / D10 (docs/folios/line-autonomy.spec.md) — the deterministic total backfill, proven
// two ways: S-15 (conservation + idempotency over hand-seeded pre-feature folios of all three
// classes) and S-16 (the migration SQL against the live TypeScript engine as an ORACLE — the
// seed-and-cascade rule exists once, in folioAllocations.ts, and this test is what keeps the SQL
// translation honest).

const CREATED_AT = 1_750_000_000

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const clearDb = async () => {
  for (const t of [
    'folio_payment_allocations',
    'folio_line_extras',
    'folio_lines',
    'folio_payments',
    'folio_events',
    'folios',
    'slots',
    'services',
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`)
  }
}

// The backfill statements, replayed verbatim — the test breaks if the SQL drifts from the file.
const backfillStatements = (): string[] => {
  const stmts = (migrationSql as string)
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.includes('INSERT INTO folio_payment_allocations'))
  expect(stmts).toHaveLength(3) // paid/cancelled payments · booking seed-cascade · refunds
  return stmts
}

const runBackfill = async () => {
  for (const stmt of backfillStatements()) {
    await env.DB.prepare(stmt).run()
  }
}

interface SeededLine {
  id: string
  lineTotal: number
  slotDate: string
  slotStartTime: string
}

let org: string
let agentId: string
let serviceId: string

const seedFolio = async (opts: {
  status: 'paid' | 'booking' | 'cancelled'
  lines: Array<{ total: number; date: string; time?: string }>
  payments: number[] // chronological magnitudes
  refunds?: number[] // magnitudes; written negative
}): Promise<{ folioId: string; lines: SeededLine[]; paymentIds: string[]; refundIds: string[] }> => {
  const folioId = crypto.randomUUID()
  const total = opts.lines.reduce((s, l) => s + l.total, 0)
  const amountPaid = opts.payments.reduce((s, a) => s + a, 0)
  await env.DB.prepare(
    `INSERT INTO folios (id, organization_id, agent_id, status, subtotal, discount_total, total, amount_paid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(folioId, org, agentId, opts.status, total, total, amountPaid, CREATED_AT, CREATED_AT)
    .run()

  const lines: SeededLine[] = []
  for (const l of opts.lines) {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO folio_lines (id, organization_id, folio_id, service_id, slot_id, service_name, slot_date, slot_start_time, quantity, base_price, minimum_price, unit_price, line_total, created_at)
       VALUES (?, ?, ?, ?, NULL, 'Tour', ?, ?, 1, ?, 0, ?, ?, ?)`,
    )
      .bind(id, org, folioId, serviceId, l.date, l.time ?? '09:00', l.total, l.total, l.total, CREATED_AT)
      .run()
    lines.push({ id, lineTotal: l.total, slotDate: l.date, slotStartTime: l.time ?? '09:00' })
  }

  const paymentIds: string[] = []
  for (const [i, amount] of opts.payments.entries()) {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO folio_payments (id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at)
       VALUES (?, ?, ?, 'payment', ?, 'cash', 'not_required', ?, ?)`,
    )
      .bind(id, org, folioId, amount, agentId, CREATED_AT + i)
      .run()
    paymentIds.push(id)
  }
  const refundIds: string[] = []
  for (const [i, amount] of (opts.refunds ?? []).entries()) {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO folio_payments (id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at)
       VALUES (?, ?, ?, 'refund', ?, 'cash', 'not_required', ?, ?)`,
    )
      .bind(id, org, folioId, -amount, agentId, CREATED_AT + 100 + i)
      .run()
    refundIds.push(id)
  }
  return { folioId, lines, paymentIds, refundIds }
}

const allocationsByPayment = async (
  paymentId: string,
): Promise<Array<{ folio_line_id: string; amount: number; backfilled: number; created_at: number }>> => {
  const { results } = await env.DB.prepare(
    `SELECT folio_line_id, amount, backfilled, created_at
     FROM folio_payment_allocations WHERE payment_id = ? ORDER BY amount DESC, folio_line_id`,
  )
    .bind(paymentId)
    .all()
  return results as never
}

const allocationCount = async (): Promise<number> => {
  const { results } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM folio_payment_allocations`,
  ).all()
  return (results[0] as { n: number }).n
}

beforeEach(async () => {
  await clearDb()
  await clearTenancyDb()
  const agent = await seedUser({ email: `agent-${crypto.randomUUID()}@a.com`, role: 'agent' })
  org = agent.organizationId
  agentId = agent.userId
  await env.DB.prepare(`UPDATE organizations SET booking_min_down_payment_pct = 30 WHERE id = ?`)
    .bind(org)
    .run()
  serviceId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO services (id, organization_id, name, description, base_price, minimum_price, default_capacity, commission_type, commission_value, status, created_at, updated_at)
     VALUES (?, ?, 'Tour', NULL, 100000, 0, 12, 'percent', 0, 'active', ?, ?)`,
  )
    .bind(serviceId, org, CREATED_AT, CREATED_AT)
    .run()
})

describe('S-15 — the backfill conserves every peso, and re-running writes nothing', () => {
  it('covers all three folio classes, marks every row backfilled, and is idempotent', async () => {
    const d3 = addDays(todayStr(), 3)
    const d5 = addDays(todayStr(), 5)
    const paid = await seedFolio({ status: 'paid', lines: [{ total: 100000, date: d3 }, { total: 50000, date: d5 }], payments: [150000] })
    const booking = await seedFolio({ status: 'booking', lines: [{ total: 100000, date: d3 }, { total: 50000, date: d5 }], payments: [60000] })
    const cancelled = await seedFolio({
      status: 'cancelled',
      lines: [{ total: 100000, date: d3 }, { total: 50000, date: d5 }],
      payments: [150000],
      refunds: [50000],
    })

    await runBackfill()

    // Conservation, per payment/refund row, over the entire database (scope boundary 3).
    const { results: perRow } = await env.DB.prepare(
      `SELECT p.id, p.amount, COALESCE(SUM(a.amount), 0) AS allocated
       FROM folio_payments p LEFT JOIN folio_payment_allocations a ON a.payment_id = p.id
       WHERE p.entry_type IN ('payment', 'refund') GROUP BY p.id`,
    ).all()
    for (const row of perRow as Array<{ amount: number; allocated: number }>) {
      expect(row.allocated).toBe(row.amount)
    }

    // Paid folio: each line covered exactly; created_at is the SOURCE payment's, never "now".
    const paidAllocs = await allocationsByPayment(paid.paymentIds[0])
    expect(paidAllocs.map((a) => a.amount).sort((x, y) => y - x)).toEqual([100000, 50000])
    expect(paidAllocs.every((a) => a.backfilled === 1 && a.created_at === CREATED_AT)).toBe(true)

    // Booking folio: the S-2 arithmetic, retroactively (seed 30k/15k + 15k cascade to the near line).
    const bookingAllocs = await allocationsByPayment(booking.paymentIds[0])
    const bookingByLine = new Map(bookingAllocs.map((a) => [a.folio_line_id, a.amount]))
    expect(bookingByLine.get(booking.lines[0].id)).toBe(45000)
    expect(bookingByLine.get(booking.lines[1].id)).toBe(15000)

    // Cancelled folio: the refund reverses pro-rata to what each line held (33334/16666 of 50000).
    const refundAllocs = await allocationsByPayment(cancelled.refundIds[0])
    const refundByLine = new Map(refundAllocs.map((a) => [a.folio_line_id, a.amount]))
    expect(refundByLine.get(cancelled.lines[0].id)).toBe(-33334)
    expect(refundByLine.get(cancelled.lines[1].id)).toBe(-16666)

    // Idempotency: a re-run inserts nothing (the per-payment NOT EXISTS guard).
    const before = await allocationCount()
    await runBackfill()
    expect(await allocationCount()).toBe(before)
  })
})

describe('S-16 — the SQL and the TypeScript engine tell the same story', () => {
  it('booking deposits across a fixture grid match seedAndCascade exactly', async () => {
    const d3 = addDays(todayStr(), 3)
    const d5 = addDays(todayStr(), 5)
    const d7 = addDays(todayStr(), 7)
    const grid: Array<{ lines: Array<{ total: number; date: string }>; deposit: number }> = [
      { lines: [{ total: 100000, date: d3 }, { total: 50000, date: d5 }], deposit: 60000 },
      { lines: [{ total: 100000, date: d3 }, { total: 50000, date: d5 }], deposit: 115000 },
      { lines: [{ total: 3333, date: d3 }, { total: 6667, date: d5 }], deposit: 3000 },
      // A deposit below today's Σ seeds — the "historical smaller %" degenerate case.
      { lines: [{ total: 100000, date: d3 }, { total: 50000, date: d5 }], deposit: 35000 },
      { lines: [{ total: 40000, date: d5 }, { total: 90000, date: d3 }, { total: 20000, date: d7 }], deposit: 51000 },
    ]
    const seeded = []
    for (const g of grid) {
      seeded.push({ g, folio: await seedFolio({ status: 'booking', lines: g.lines, payments: [g.deposit] }) })
    }

    await runBackfill()

    for (const { g, folio } of seeded) {
      const oracle = seedAndCascade(
        folio.lines.map((l) => ({ id: l.id, lineTotal: l.lineTotal, slotDate: l.slotDate, slotStartTime: l.slotStartTime })),
        30,
        g.deposit,
      )
      const dbAllocs = await allocationsByPayment(folio.paymentIds[0])
      const byLine = new Map(dbAllocs.map((a) => [a.folio_line_id, a.amount]))
      expect(byLine.size).toBe(oracle.length)
      for (const o of oracle) {
        expect(byLine.get(o.folioLineId), `line ${o.folioLineId} of deposit ${g.deposit}`).toBe(o.amount)
      }
    }
  })

  it('a paid deposit+settle folio matches the interval model over full line_totals', async () => {
    const d3 = addDays(todayStr(), 3)
    const d5 = addDays(todayStr(), 5)
    const folio = await seedFolio({
      status: 'paid',
      lines: [{ total: 100000, date: d3 }, { total: 50000, date: d5 }],
      payments: [60000, 90000],
    })

    await runBackfill()

    const lines = folio.lines.map((l) => ({ id: l.id, lineTotal: l.lineTotal, slotDate: l.slotDate, slotStartTime: l.slotStartTime }))
    const oracle = splitRows(allocateFull(lines), [60000, 90000])
    for (const [i, paymentId] of folio.paymentIds.entries()) {
      const dbAllocs = await allocationsByPayment(paymentId)
      const byLine = new Map(dbAllocs.map((a) => [a.folio_line_id, a.amount]))
      expect(byLine.size).toBe(oracle[i].length)
      for (const o of oracle[i]) {
        expect(byLine.get(o.folioLineId)).toBe(o.amount)
      }
    }
  })

  it('a partially-refunded cancellation matches prorateByWeight over the payment coverage', async () => {
    const d3 = addDays(todayStr(), 3)
    const d5 = addDays(todayStr(), 5)
    // Ex-booking: only 60000 was ever collected, then cancelled with 25000 given back.
    const folio = await seedFolio({
      status: 'cancelled',
      lines: [{ total: 100000, date: d3 }, { total: 50000, date: d5 }],
      payments: [60000],
      refunds: [25000],
    })

    await runBackfill()

    const lines = folio.lines.map((l) => ({ id: l.id, lineTotal: l.lineTotal, slotDate: l.slotDate, slotStartTime: l.slotStartTime }))
    // Cancelled payments use the plain interval model: 60000 covers the near line only.
    const coverage = splitRows(allocateFull(lines), [60000])[0]
    const paymentAllocs = await allocationsByPayment(folio.paymentIds[0])
    const payByLine = new Map(paymentAllocs.map((a) => [a.folio_line_id, a.amount]))
    for (const cSeg of coverage) {
      expect(payByLine.get(cSeg.folioLineId)).toBe(cSeg.amount)
    }
    // The refund is pro-rata to that coverage, largest remainder to the heaviest line.
    const shares = prorateByWeight(
      coverage.map((cSeg) => ({ folioLineId: cSeg.folioLineId, weight: cSeg.amount })),
      25000,
    )
    const refundAllocs = await allocationsByPayment(folio.refundIds[0])
    const refByLine = new Map(refundAllocs.map((a) => [a.folio_line_id, a.amount]))
    expect(refByLine.size).toBe(shares.length)
    for (const s of shares) {
      expect(refByLine.get(s.folioLineId)).toBe(-s.amount)
    }
  })

  it('bookingSegments is the exact segment sequence the SQL lays payments over', () => {
    // A pure cross-check that the two-pass segment order (all seeds, then all remainders) is what
    // seedAndCascade consumes — if someone reorders one side, S-16 above fails; this names why.
    const lines = [
      { id: 'near', lineTotal: 100000, slotDate: '2026-08-18', slotStartTime: '09:00' },
      { id: 'far', lineTotal: 50000, slotDate: '2026-08-20', slotStartTime: '07:30' },
    ]
    expect(bookingSegments(lines, 30)).toEqual([
      { folioLineId: 'near', amount: 30000 },
      { folioLineId: 'far', amount: 15000 },
      { folioLineId: 'near', amount: 70000 },
      { folioLineId: 'far', amount: 35000 },
    ])
  })
})
