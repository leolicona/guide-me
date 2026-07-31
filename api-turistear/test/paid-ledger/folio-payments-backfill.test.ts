import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { seedUser, seedFolioLedgerRows } from '../helpers/tenancy'

// US-LG01 (docs/paid-ledger/paid-ledger.spec.md) — the folio_payments ledger and its reconciliation invariant.
//
// The Step-1 backfill migration (0049) ran historically against folios.payment_method, which US-LG08
// (0051) has since DROPPED — so it can no longer be re-run against the current schema, and its
// one-time correctness is verified by the harness applying it at setup. What endures, and is proven
// here, is the invariant every reader depends on: a folio's money scalars equal the sum of its
// ledger rows —
//   Σ(payment + refund).amount      == folios.amount_paid
//   Σ(commission + commission_reversal).amount == folios.commission_amount
// seeded exactly the way the migration + every production write path shape the ledger.

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  paymentMethod?: 'cash' | 'card' | 'transfer' | 'link'
  amountPaid: number
  commissionAmount?: number
  cancellationClawback?: boolean
  cancelledAt?: number
}

const CREATED_AT = 1_750_000_000

// Seed a folio + its ledger rows the way the current schema does (no payment_method column).
const seedFolio = async (opts: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, status, subtotal, discount_total, total, amount_paid,
        commission_amount, cancellation_clawback, cancelled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.organizationId,
      opts.agentId,
      opts.status ?? 'paid',
      opts.amountPaid,
      opts.amountPaid,
      opts.amountPaid,
      opts.commissionAmount ?? 0,
      opts.cancellationClawback ? 1 : 0,
      opts.cancelledAt ?? null,
      CREATED_AT,
      CREATED_AT,
    )
    .run()
  await seedFolioLedgerRows({
    folioId: id,
    organizationId: opts.organizationId,
    agentId: opts.agentId,
    status: opts.status ?? 'paid',
    paymentMethod: opts.paymentMethod ?? 'cash',
    amountPaid: opts.amountPaid,
    commissionAmount: opts.commissionAmount ?? 0,
    cancellationClawback: opts.cancellationClawback ?? false,
    cancelledAt: opts.cancelledAt,
    createdAt: CREATED_AT,
  })
  return id
}

const rowsForFolio = async (folioId: string) => {
  const { results } = await env.DB.prepare(
    `SELECT * FROM folio_payments WHERE folio_id = ? ORDER BY entry_type`,
  )
    .bind(folioId)
    .all()
  return results as Array<Record<string, unknown>>
}

const expectReconciled = async (folioId: string) => {
  const [scalar] = (
    await env.DB.prepare(`SELECT amount_paid, commission_amount FROM folios WHERE id = ?`)
      .bind(folioId)
      .all()
  ).results as Array<{ amount_paid: number; commission_amount: number }>
  const rows = await rowsForFolio(folioId)
  const money = rows
    .filter((r) => r.entry_type === 'payment' || r.entry_type === 'refund')
    .reduce((s, r) => s + (r.amount as number), 0)
  const commission = rows
    .filter((r) => r.entry_type === 'commission' || r.entry_type === 'commission_reversal')
    .reduce((s, r) => s + (r.amount as number), 0)
  expect(money).toBe(scalar.amount_paid)
  expect(commission).toBe(scalar.commission_amount)
}

describe('US-LG01 — folio_payments reconciliation invariant', () => {
  let orgA: string
  let agentA: string

  beforeEach(async () => {
    const seeded = await seedUser({ email: `agent-${crypto.randomUUID()}@a.com`, role: 'agent' })
    orgA = seeded.organizationId
    agentA = seeded.userId
  })

  it('a paid folio: one payment row (= amount_paid) + one commission row (= commission_amount)', async () => {
    const folio = await seedFolio({ organizationId: orgA, agentId: agentA, amountPaid: 10_000, commissionAmount: 1_500 })
    const rows = await rowsForFolio(folio)
    expect(rows.filter((r) => r.entry_type === 'payment')).toHaveLength(1)
    expect(rows.filter((r) => r.entry_type === 'commission')).toHaveLength(1)
    const payment = rows.find((r) => r.entry_type === 'payment')!
    expect(payment.amount).toBe(10_000)
    expect(payment.method).toBe('cash')
    expect(payment.collected_by).toBe(agentA)
    await expectReconciled(folio)
  })

  it('a booking deposit accrues no commission until settle → no commission row', async () => {
    const booking = await seedFolio({ organizationId: orgA, agentId: agentA, status: 'booking', amountPaid: 5_000, commissionAmount: 0 })
    const rows = await rowsForFolio(booking)
    expect(rows.filter((r) => r.entry_type === 'commission')).toHaveLength(0)
    expect(rows.filter((r) => r.entry_type === 'payment')).toHaveLength(1)
    await expectReconciled(booking)
  })

  it('a clawed-back cancellation nets money AND commission to zero (reversal rows)', async () => {
    const clawed = await seedFolio({
      organizationId: orgA,
      agentId: agentA,
      status: 'cancelled',
      amountPaid: 8_000,
      commissionAmount: 1_200,
      cancellationClawback: true,
      cancelledAt: CREATED_AT + 500,
    })
    const rows = await rowsForFolio(clawed)
    const money = rows
      .filter((r) => r.entry_type === 'payment' || r.entry_type === 'refund')
      .reduce((s, r) => s + (r.amount as number), 0)
    const commission = rows
      .filter((r) => r.entry_type === 'commission' || r.entry_type === 'commission_reversal')
      .reduce((s, r) => s + (r.amount as number), 0)
    expect(money).toBe(0) // +8000 payment − 8000 refund
    expect(commission).toBe(0) // +1200 − 1200 reversal
  })

  it('an absorbed cancellation reverses money but KEEPS the commission', async () => {
    const absorbed = await seedFolio({
      organizationId: orgA,
      agentId: agentA,
      status: 'cancelled',
      amountPaid: 6_000,
      commissionAmount: 900,
      cancellationClawback: false,
      cancelledAt: CREATED_AT + 500,
    })
    const rows = await rowsForFolio(absorbed)
    const commission = rows
      .filter((r) => r.entry_type === 'commission' || r.entry_type === 'commission_reversal')
      .reduce((s, r) => s + (r.amount as number), 0)
    expect(commission).toBe(900) // kept — no reversal row
  })

  it('B4 — cross-org isolation: a folio’s ledger rows never cross tenant boundaries', async () => {
    const other = await seedUser({ email: `agent-${crypto.randomUUID()}@b.com`, role: 'agent' })
    const orgB = other.organizationId
    const folioA = await seedFolio({ organizationId: orgA, agentId: agentA, amountPaid: 1_000, commissionAmount: 100 })
    const folioB = await seedFolio({ organizationId: orgB, agentId: other.userId, amountPaid: 2_000, commissionAmount: 200 })

    const aRows = await rowsForFolio(folioA)
    const bRows = await rowsForFolio(folioB)
    expect(aRows.every((r) => r.organization_id === orgA)).toBe(true)
    expect(bRows.every((r) => r.organization_id === orgB)).toBe(true)
  })
})
