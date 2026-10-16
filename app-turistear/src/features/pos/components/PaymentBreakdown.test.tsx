// devolada-transfer-verification US1 — a pending row of the payment breakdown says who is
// verifying it: «En verificación» while Devolada does (`verification_auto`), «Por verificar»
// when it is the admin's work (research D14; contracts/turistear-api.md § Action copy).
import { describe, expect, it } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import type { FolioPaymentEntry } from '../types'
import { PaymentBreakdown } from './PaymentBreakdown'

const payment = (over: Partial<FolioPaymentEntry>): FolioPaymentEntry => ({
  id: 'pay-1',
  kind: 'payment',
  method: 'cash',
  amount: 50_000,
  reference: null,
  verification: 'not_required',
  collected_at: 1_800_000_000,
  ...over,
})

// A cash deposit, then a balance by transfer nobody has verified yet.
const payments = [
  payment({ id: 'pay-1' }),
  payment({
    id: 'pay-2',
    method: 'transfer',
    amount: 100_000,
    verification: 'pending',
    collected_at: 1_800_086_400,
  }),
]

describe('PaymentBreakdown', () => {
  it('a pending row on a sale Devolada is verifying reads «En verificación»', async () => {
    const { container } = renderWithProviders(
      <PaymentBreakdown payments={payments} verificationAuto />,
    )
    expect(screen.getByText('En verificación')).toBeInTheDocument()
    expect(screen.queryByText('Por verificar')).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('otherwise the pending row is the admin’s work: «Por verificar»', async () => {
    const { container } = renderWithProviders(<PaymentBreakdown payments={payments} />)
    expect(screen.getByText('Por verificar')).toBeInTheDocument()
    expect(screen.queryByText('En verificación')).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('a row that needs no verification carries no chip either way', () => {
    renderWithProviders(
      <PaymentBreakdown
        payments={payments.map((p) => ({ ...p, verification: 'verified' as const }))}
        verificationAuto
      />,
    )
    expect(screen.queryByText('En verificación')).not.toBeInTheDocument()
    expect(screen.queryByText('Por verificar')).not.toBeInTheDocument()
  })
})

// devolada-transfer-verification US2 — a sale the system cancelled because its transfer never
// arrived (D11): the row that waited for it is nobody's work any more, and says what happened to it
// (contracts/turistear-api.md § Action copy).
describe('devolada-transfer-verification US2 — money that never arrived', () => {
  // The transfer that never came, and the cancellation's reversal of it.
  const withdrawn = [
    payment({
      id: 'pay-1',
      method: 'transfer',
      amount: 150_000,
      verification: 'pending',
    }),
    payment({ id: 'pay-2', kind: 'refund', method: 'transfer', amount: -150_000 }),
  ]

  it('a pending row of a sale cancelled with `payment_not_received` reads «No recibido»', async () => {
    const { container } = renderWithProviders(
      <PaymentBreakdown payments={withdrawn} cancellationSource="payment_not_received" />,
    )
    expect(screen.getByText('No recibido')).toBeInTheDocument()
    expect(screen.queryByText('Por verificar')).not.toBeInTheDocument()
    expect(screen.queryByText('En verificación')).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('a sale cancelled any other way keeps «Por verificar»', () => {
    renderWithProviders(<PaymentBreakdown payments={withdrawn} cancellationSource="admin" />)
    expect(screen.getByText('Por verificar')).toBeInTheDocument()
    expect(screen.queryByText('No recibido')).not.toBeInTheDocument()
  })
})
