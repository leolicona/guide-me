import type { Db } from '../db/client'
import { folioPayments } from '../db/schema'

// US-LG (docs/paid-ledger/spec.md) — builders that RETURN a Drizzle insert statement for a
// folio_payments row, so a caller can add it to its own `db.batch(...)` and persist the ledger row
// ATOMICALLY with the folio-scalar mutation it shadows. Step 2 dual-writes only the money movements
// whose scalars move in lockstep (payment + commission); refund/commission_reversal rows arrive in
// Step 4 alongside the scalar-semantic change (amount_paid decrement, §12a removal).

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
  collectedBy: string // the agent/manager whose caja earns it
  createdAt?: Date
}

// A commission accrual carries no payment method (D2) — money vs accrual is the `entry_type` axis.
export const commissionRow = (db: Db, input: CommissionRowInput) =>
  db.insert(folioPayments).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    folioId: input.folioId,
    entryType: 'commission',
    amount: input.amount,
    method: null,
    verification: 'not_required',
    collectedBy: input.collectedBy,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  })
