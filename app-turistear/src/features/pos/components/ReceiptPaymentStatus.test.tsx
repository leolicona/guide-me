// devolada-transfer-verification US1 — the receipt says where the sale's money stands: «Pago en
// verificación» while nobody has verified the transfer, never «Venta confirmada» and «Pagado»
// (research D16 and defect 7; contracts/turistear-api.md § Action copy). The status line, the
// chip beside «Recibo» and the US-A67 note are mounted together, as the receipt places them.
import { describe, expect, it } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import {
  ReceiptPaymentChip,
  ReceiptPaymentStatus,
  ReceiptVerificationNote,
  type ReceiptStatusFolio,
} from './ReceiptPaymentStatus'

const NOTE = 'Los boletos se enviarán en cuanto un administrador confirme la transferencia.'

const sale = (over: Partial<ReceiptStatusFolio> = {}): ReceiptStatusFolio => ({
  status: 'paid',
  booking_expires_at: null,
  payment_verification: 'not_required',
  verification_auto: false,
  ...over,
})

function Receipt({ folio }: { folio: ReceiptStatusFolio }) {
  return (
    <>
      <ReceiptPaymentStatus folio={folio} />
      <ReceiptVerificationNote folio={folio} />
      <ReceiptPaymentChip folio={folio} />
    </>
  )
}

const heading = () => screen.getByRole('heading', { level: 1 })

describe('ReceiptPaymentStatus', () => {
  it('a transfer nobody has verified reads «Pago en verificación», with no «Pagado»', async () => {
    const { container } = renderWithProviders(
      <Receipt folio={sale({ payment_verification: 'pending' })} />,
    )
    expect(heading()).toHaveTextContent('Pago en verificación')
    expect(screen.queryByText('Venta confirmada')).not.toBeInTheDocument()
    expect(screen.queryByText('Pagado')).not.toBeInTheDocument()
    expect(screen.getByText('En verificación')).toBeInTheDocument()
    // The note explains the wait without saying the status line twice.
    expect(screen.getByText(NOTE)).toBeInTheDocument()
    expect(screen.getAllByText('Pago en verificación')).toHaveLength(1)
    await expectNoA11yViolations(container)
  })

  it('once verified: «Venta confirmada» and «Pagado»', async () => {
    const { container } = renderWithProviders(
      <Receipt folio={sale({ payment_verification: 'verified' })} />,
    )
    expect(heading()).toHaveTextContent('Venta confirmada')
    expect(screen.getByText('Pagado')).toBeInTheDocument()
    expect(screen.queryByText(/verificación/)).not.toBeInTheDocument()
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('cash, which needs no verification, is confirmed as before', () => {
    renderWithProviders(<Receipt folio={sale()} />)
    expect(heading()).toHaveTextContent('Venta confirmada')
    expect(screen.getByText('Pagado')).toBeInTheDocument()
  })

  it('a sale Devolada is verifying names no admin', () => {
    renderWithProviders(
      <Receipt folio={sale({ payment_verification: 'pending', verification_auto: true })} />,
    )
    expect(heading()).toHaveTextContent('Pago en verificación')
    expect(screen.queryByText('Pagado')).not.toBeInTheDocument()
    expect(screen.queryByText(/administrador/)).not.toBeInTheDocument()
  })

  describe("an apartado keeps today's header and chip", () => {
    it('registered: «Apartado registrado» and «Apartado»', async () => {
      const { container } = renderWithProviders(
        <Receipt folio={sale({ status: 'booking', booking_expires_at: 1_800_000_000 })} />,
      )
      expect(heading()).toHaveTextContent('Apartado registrado')
      expect(screen.getByText('Apartado')).toBeInTheDocument()
      expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
      await expectNoA11yViolations(container)
    })

    it('its unverified deposit keeps the whole note, title included', () => {
      renderWithProviders(
        <Receipt
          folio={sale({
            status: 'booking',
            booking_expires_at: 1_800_000_000,
            payment_verification: 'pending',
          })}
        />,
      )
      expect(heading()).toHaveTextContent('Apartado registrado')
      expect(screen.getByText('Apartado')).toBeInTheDocument()
      expect(screen.getByText('Pago en verificación')).toBeInTheDocument()
      expect(screen.getByText(NOTE)).toBeInTheDocument()
    })

    it('expired: «Apartado vencido» and «Cancelado»', () => {
      renderWithProviders(
        <Receipt folio={sale({ status: 'cancelled', booking_expires_at: 1_800_000_000 })} />,
      )
      expect(heading()).toHaveTextContent('Apartado vencido')
      expect(screen.getByText('Cancelado')).toBeInTheDocument()
    })
  })
})
