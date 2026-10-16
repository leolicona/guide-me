import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { PaymentBreakdown } from './PaymentBreakdown'
import type { FolioPaymentEntry } from '../types'

// bug: reject-settle-voids-deposit — a rejected transfer stays on the record, labelled, beside the
// reversal that took its money out; it never reads as "Por verificar" again.

const entry = (over: Partial<FolioPaymentEntry>): FolioPaymentEntry => ({
  id: crypto.randomUUID(),
  kind: 'payment',
  method: 'cash',
  amount: 45000,
  reference: null,
  verification: 'not_required',
  collected_at: 1_700_000_000,
  ...over,
})

describe('bug: reject-settle-voids-deposit — the breakdown of a rejected settlement', () => {
  it('labels the rejected transfer and shows its reversal', async () => {
    const { container } = renderWithProviders(
      <PaymentBreakdown
        payments={[
          entry({}),
          entry({ method: 'transfer', amount: 105000, verification: 'rejected', reference: 'BBVA-1' }),
          entry({ kind: 'refund', method: 'transfer', amount: -105000 }),
        ]}
      />,
    )
    expect(screen.getByText('Rechazado')).toBeInTheDocument()
    expect(screen.queryByText('Por verificar')).toBeNull()
    expect(screen.getByText('Reversa · Transferencia')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })
})
