import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { folioPayments } from '../db/schema'

// US-LG08 — the folio's DISPLAY method, derived from its collection (payment) rows: the shared
// method when all agree, else the literal 'Mixto'. A correlated subquery, so it drops into any
// folios SELECT with no fan-out and no extra round-trip — the replacement for the dropped
// folios.payment_method column. (A folio always has ≥1 payment row, so the else branch is a method.)
// The correlation references the outer `folios.id` by its raw SQL name (every reader queries the
// unaliased `folios` table), which renders as a stable column reference in the subquery.
export const displayMethodSql = sql<string>`(
  select case when count(distinct fp.method) > 1 then 'Mixto' else max(fp.method) end
  from folio_payments fp
  where fp.folio_id = folios.id and fp.entry_type = 'payment'
)`

// The deposit / first collection's own method — the settle default when the caller sends none.
export const depositMethodSql = sql<string>`(
  select fp.method from folio_payments fp
  where fp.folio_id = folios.id and fp.entry_type = 'payment'
  order by fp.created_at asc limit 1
)`

// US-LG (docs/paid-ledger/spec.md) — builders that RETURN a Drizzle insert statement for a
// folio_payments row, so a caller can add it to its own `db.batch(...)` and persist the ledger row
// ATOMICALLY with the folio-scalar mutation it shadows / the cancellation it records.
//
// The ledger is the cash engine's source of truth (Step 4): a SIGNED `amount` per movement, the
// `entry_type` axis splitting money (payment/refund, method-bearing) from commission accruals
// (commission/commission_reversal). A commission row carries the METHOD of the collection it
// accrues on, so the cash engine can bucket commission cash-vs-electronic (US-AG29). Reversal rows
// are dated at the reversal event (cancelled_at) so the drop-watermark fast path absorbs a
// post-watermark cancellation as an ordinary current-shift event — which is what lets the §12a
// `sumCancellationReversal` hack be deleted.

type Method = 'cash' | 'card' | 'transfer' | 'link'
type Verification = 'not_required' | 'pending' | 'verified'

interface PaymentRowInput {
  organizationId: string
  folioId: string
  amount: number // > 0 minor units collected in THIS movement (deposit or balance)
  method: Method
  reference?: string | null
  verification: Verification
  collectedBy: string // the user who took this money (a settle may differ from the seller, D8)
  operatorId?: string | null // the PIN shift that took it (US-A68); null in-house
  createdAt?: Date // the money's own date; omit to use the DB default (unixepoch())
}

export const paymentRow = (db: Db, input: PaymentRowInput) =>
  db.insert(folioPayments).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    folioId: input.folioId,
    entryType: 'payment',
    amount: input.amount,
    method: input.method,
    reference: input.reference ?? null,
    verification: input.verification,
    collectedBy: input.collectedBy,
    operatorId: input.operatorId ?? null,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  })

interface CommissionRowInput {
  organizationId: string
  folioId: string
  amount: number // > 0 minor units accrued in THIS movement (initial accrual or settle top-up)
  method: Method // the collection method this commission accrues on (for the cash/electronic bucket)
  collectedBy: string // the agent/manager whose caja earns it
  createdAt?: Date
}

export const commissionRow = (db: Db, input: CommissionRowInput) =>
  db.insert(folioPayments).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    folioId: input.folioId,
    entryType: 'commission',
    amount: input.amount,
    method: input.method,
    verification: 'not_required',
    collectedBy: input.collectedBy,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  })

interface ReversalRowInput {
  organizationId: string
  folioId: string
  amount: number // > 0 magnitude to reverse; written as a NEGATIVE row
  method: Method
  collectedBy: string // the agent whose money/commission is reversed (NOT the admin who cancelled)
  at: Date // cancelled_at — the reversal's own date, so the watermark fast path sees it
}

// A cancellation reverses the money collected on the folio (its sale leaves the sales/cash buckets).
export const refundRow = (db: Db, input: ReversalRowInput) =>
  db.insert(folioPayments).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    folioId: input.folioId,
    entryType: 'refund',
    amount: -Math.abs(input.amount),
    method: input.method,
    verification: 'not_required',
    collectedBy: input.collectedBy,
    createdAt: input.at,
  })

// A clawback reverses the commission the agent had accrued (US-A26). An ABSORBED cancellation
// (clawback=false) writes none — the agent keeps the commission.
export const commissionReversalRow = (db: Db, input: ReversalRowInput) =>
  db.insert(folioPayments).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    folioId: input.folioId,
    entryType: 'commission_reversal',
    amount: -Math.abs(input.amount),
    method: input.method,
    verification: 'not_required',
    collectedBy: input.collectedBy,
    createdAt: input.at,
  })

// The one entry point every cancellation site uses (admin cancel, tourist-approved cancel, booking
// cancel, payment reject). Reads the folio's NET money AND commission per method from the ledger and
// reverses each positive bucket — so a MIXED folio reverses cash and transfer (and their commission
// accruals) in the RIGHT proportions, not lumped into the deposit method. Dated at `at`
// (cancelled_at) so the drop-watermark fast path treats it as a current-shift event. Commission is
// reversed only on `clawback` (an absorbed cancellation keeps it).
export const buildCancellationReversal = async (
  db: Db,
  input: {
    organizationId: string
    folioId: string
    collectedBy: string
    at: Date
    clawback: boolean
  },
) => {
  const grouped = await db
    .select({
      method: folioPayments.method,
      money: sql<number>`coalesce(sum(case when ${folioPayments.entryType} in ('payment','refund') then ${folioPayments.amount} else 0 end), 0)`,
      commission: sql<number>`coalesce(sum(case when ${folioPayments.entryType} in ('commission','commission_reversal') then ${folioPayments.amount} else 0 end), 0)`,
    })
    .from(folioPayments)
    .where(
      and(
        eq(folioPayments.organizationId, input.organizationId),
        eq(folioPayments.folioId, input.folioId),
      ),
    )
    .groupBy(folioPayments.method)

  const rows = []
  for (const r of grouped) {
    if (!r.method) continue
    const method = r.method as Method
    const money = Number(r.money ?? 0)
    if (money > 0) {
      rows.push(
        refundRow(db, {
          organizationId: input.organizationId,
          folioId: input.folioId,
          amount: money,
          method,
          collectedBy: input.collectedBy,
          at: input.at,
        }),
      )
    }
    const commission = Number(r.commission ?? 0)
    if (input.clawback && commission > 0) {
      rows.push(
        commissionReversalRow(db, {
          organizationId: input.organizationId,
          folioId: input.folioId,
          amount: commission,
          method,
          collectedBy: input.collectedBy,
          at: input.at,
        }),
      )
    }
  }
  return rows
}
