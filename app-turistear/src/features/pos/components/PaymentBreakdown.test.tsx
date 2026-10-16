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
