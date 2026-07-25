import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { seedUser } from '../helpers/tenancy'

// US-LG01 (docs/paid-ledger/spec.md) — Step 1: the folio_payments ledger + backfill.
//
// The table DDL is validated IMPLICITLY: the whole suite only boots if 0049_folio_payments.sql
// applied cleanly at setup (apply-migrations.ts). What we prove here is the backfill LOGIC —
// per-folio invariants, idempotency, and cross-org isolation. Because the migration ran against an
// empty DB at setup, we seed folios and then run the canonical backfill statements below.
//
// These two statements MIRROR migrations/0049_folio_payments.sql verbatim; keep them in lockstep.
const BACKFILL_PAYMENTS = `
INSERT INTO folio_payments (
  id, organization_id, folio_id, entry_type, amount, method, reference, verification,
  collected_by, operator_id, verified_at, verified_by, created_at
)
SELECT 'pmt_' || f.id, f.organization_id, f.id, 'payment', f.amount_paid, f.payment_method,
       f.payment_reference, f.payment_verification, f.agent_id, f.operator_id,
       f.payment_verified_at, f.payment_verified_by, f.created_at
FROM folios f
WHERE NOT EXISTS (SELECT 1 FROM folio_payments p WHERE p.id = 'pmt_' || f.id)`

const BACKFILL_COMMISSIONS = `
INSERT INTO folio_payments (
  id, organization_id, folio_id, entry_type, amount, method, verification, collected_by, created_at
)
SELECT 'cmn_' || f.id, f.organization_id, f.id, 'commission', f.commission_amount, NULL,
       'not_required', f.agent_id, f.created_at
FROM folios f
WHERE f.commission_amount > 0
  AND NOT EXISTS (SELECT 1 FROM folio_payments p WHERE p.id = 'cmn_' || f.id)`

const runBackfill = async () => {
  await env.DB.prepare(BACKFILL_PAYMENTS).run()
  await env.DB.prepare(BACKFILL_COMMISSIONS).run()
}

interface SeedFolioOptions {
  organizationId: string
  agentId: string
  status?: 'paid' | 'booking' | 'cancelled'
  paymentMethod?: 'cash' | 'card' | 'transfer' | 'link'
  paymentReference?: string | null
  paymentVerification?: 'not_required' | 'pending' | 'verified'
  paymentVerifiedAt?: number | null
  paymentVerifiedBy?: string | null
  amountPaid: number
  commissionAmount?: number
  createdAt?: number
}

const CREATED_AT = 1_750_000_000

const seedFolio = async (opts: SeedFolioOptions): Promise<string> => {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO folios
       (id, organization_id, agent_id, status, payment_method, payment_reference,
        payment_verification, payment_verified_at, payment_verified_by,
        subtotal, discount_total, total, amount_paid, commission_amount, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      opts.organizationId,
      opts.agentId,
      opts.status ?? 'paid',
      opts.paymentMethod ?? 'cash',
      opts.paymentReference ?? null,
      opts.paymentVerification ?? 'not_required',
      opts.paymentVerifiedAt ?? null,
      opts.paymentVerifiedBy ?? null,
      opts.amountPaid,
      opts.amountPaid,
      opts.amountPaid,
      opts.commissionAmount ?? 0,
      opts.createdAt ?? CREATED_AT,
      opts.createdAt ?? CREATED_AT,
    )
    .run()
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

describe('US-LG01 — folio_payments backfill (Step 1)', () => {
  let orgA: string
  let agentA: string

  beforeEach(async () => {
    // Fresh isolated DB per test file is not guaranteed, so scope every assertion to seeded ids.
    const seeded = await seedUser({ email: `agent-${crypto.randomUUID()}@a.com`, role: 'agent' })
    orgA = seeded.organizationId
    agentA = seeded.userId
  })

  it('seeds one payment row per folio mirroring its money scalars', async () => {
    const cash = await seedFolio({
      organizationId: orgA,
      agentId: agentA,
      paymentMethod: 'cash',
      amountPaid: 10_000,
      commissionAmount: 1_500,
    })
    await runBackfill()

    const rows = await rowsForFolio(cash)
    const payment = rows.find((r) => r.entry_type === 'payment')!
    expect(payment).toBeDefined()
    expect(payment.amount).toBe(10_000)
    expect(payment.method).toBe('cash')
    expect(payment.reference).toBeNull()
    expect(payment.verification).toBe('not_required')
    expect(payment.collected_by).toBe(agentA)
    expect(payment.operator_id).toBeNull()
    expect(payment.created_at).toBe(CREATED_AT)
    // deterministic, idempotency-friendly id
    expect(payment.id).toBe(`pmt_${cash}`)
  })

  it('mirrors an electronic (verified transfer) payment: reference + verification + verified audit', async () => {
    const verifiedAt = 1_750_500_000
    const transfer = await seedFolio({
      organizationId: orgA,
      agentId: agentA,
      paymentMethod: 'transfer',
      paymentReference: 'BANK-REF-123',
      paymentVerification: 'verified',
      paymentVerifiedAt: verifiedAt,
      paymentVerifiedBy: agentA,
      amountPaid: 20_000,
      commissionAmount: 3_000,
    })
    await runBackfill()

    const payment = (await rowsForFolio(transfer)).find((r) => r.entry_type === 'payment')!
    expect(payment.method).toBe('transfer')
    expect(payment.reference).toBe('BANK-REF-123')
    expect(payment.verification).toBe('verified')
    expect(payment.verified_at).toBe(verifiedAt)
    expect(payment.verified_by).toBe(agentA)
  })

  it('emits a commission row only when commission_amount > 0 (a booking deposit gets none)', async () => {
    const booking = await seedFolio({
      organizationId: orgA,
      agentId: agentA,
      status: 'booking',
      amountPaid: 5_000,
      commissionAmount: 0,
    })
    const withCommission = await seedFolio({
      organizationId: orgA,
      agentId: agentA,
      amountPaid: 12_000,
      commissionAmount: 1_800,
    })
    await runBackfill()

    const bookingRows = await rowsForFolio(booking)
    expect(bookingRows.filter((r) => r.entry_type === 'commission')).toHaveLength(0)
    expect(bookingRows.filter((r) => r.entry_type === 'payment')).toHaveLength(1)

    const commission = (await rowsForFolio(withCommission)).find(
      (r) => r.entry_type === 'commission',
    )!
    expect(commission.amount).toBe(1_800)
    expect(commission.method).toBeNull()
    expect(commission.verification).toBe('not_required')
    expect(commission.collected_by).toBe(agentA)
    expect(commission.id).toBe(`cmn_${withCommission}`)
  })

  it('backfills a clawed-back cancelled folio faithfully (scalar mirror; reader excludes it later)', async () => {
    // Faithful mirror per D11: the +commission row equals the retained scalar. The cash engine's
    // clawback exclusion is a Step-4 reader concern, not a backfill concern.
    const clawed = await seedFolio({
      organizationId: orgA,
      agentId: agentA,
      status: 'cancelled',
      amountPaid: 8_000,
      commissionAmount: 1_200,
    })
    await runBackfill()

    const rows = await rowsForFolio(clawed)
    const paySum = rows
      .filter((r) => r.entry_type === 'payment' || r.entry_type === 'refund')
      .reduce((s, r) => s + (r.amount as number), 0)
    const commissionSum = rows
      .filter((r) => r.entry_type === 'commission' || r.entry_type === 'commission_reversal')
      .reduce((s, r) => s + (r.amount as number), 0)
    expect(paySum).toBe(8_000)
    expect(commissionSum).toBe(1_200)
  })

  it('reconciliation invariant holds per folio: Σ money = amount_paid, Σ commission = commission_amount', async () => {
    const folios = [
      await seedFolio({ organizationId: orgA, agentId: agentA, amountPaid: 3_300, commissionAmount: 0 }),
      await seedFolio({ organizationId: orgA, agentId: agentA, paymentMethod: 'card', amountPaid: 9_900, commissionAmount: 990 }),
      await seedFolio({ organizationId: orgA, agentId: agentA, status: 'booking', amountPaid: 4_500, commissionAmount: 0 }),
    ]
    await runBackfill()

    for (const folioId of folios) {
      const [scalar] = (
        await env.DB.prepare(
          `SELECT amount_paid, commission_amount FROM folios WHERE id = ?`,
        )
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
  })

  it('is idempotent — re-running the backfill creates no duplicate rows', async () => {
    const folio = await seedFolio({
      organizationId: orgA,
      agentId: agentA,
      amountPaid: 7_000,
      commissionAmount: 700,
    })
    await runBackfill()
    const first = await rowsForFolio(folio)
    await runBackfill()
    await runBackfill()
    const after = await rowsForFolio(folio)
    expect(after).toHaveLength(first.length)
    expect(after).toHaveLength(2) // one payment + one commission
  })

  it('B4 — cross-org isolation: a backfill never crosses tenant boundaries', async () => {
    const other = await seedUser({ email: `agent-${crypto.randomUUID()}@b.com`, role: 'agent' })
    const orgB = other.organizationId
    const folioA = await seedFolio({ organizationId: orgA, agentId: agentA, amountPaid: 1_000, commissionAmount: 100 })
    const folioB = await seedFolio({ organizationId: orgB, agentId: other.userId, amountPaid: 2_000, commissionAmount: 200 })
    await runBackfill()

    // Every ledger row's organization_id matches its folio's organization_id — no leakage.
    const { results } = await env.DB.prepare(
      `SELECT p.organization_id AS p_org, f.organization_id AS f_org
         FROM folio_payments p JOIN folios f ON f.id = p.folio_id
        WHERE p.folio_id IN (?, ?)`,
    )
      .bind(folioA, folioB)
      .all()
    for (const r of results as Array<{ p_org: string; f_org: string }>) {
      expect(r.p_org).toBe(r.f_org)
    }

    // Org B's rows reference only org B's folio, and vice versa.
    const bRows = await rowsForFolio(folioB)
    expect(bRows.every((r) => r.organization_id === orgB)).toBe(true)
    const aRows = await rowsForFolio(folioA)
    expect(aRows.every((r) => r.organization_id === orgA)).toBe(true)
  })
})
