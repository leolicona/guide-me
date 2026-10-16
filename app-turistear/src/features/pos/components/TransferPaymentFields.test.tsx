// devolada-transfer-verification US1, US3 — what picking Transferencia asks of the seller, by the
// organization's Devolada connection (research D6, D8, D16; contracts/turistear-api.md § Action
// copy): connected, the transfer is collected by enlace and offers no reference (FR-009), whether it
// pays a full sale or, since T058, an apartado's deposit; a broken connection keeps the manual path
// and says why (FR-010); without Devolada, US-A88's reference rules, unchanged. The copy is asserted
// verbatim: it is the contract's.
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders, screen, userEvent } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import type { OrganizationDevoladaSummary } from '../../devolada'
import { TransferPaymentFields, type TransferPaymentFieldsProps } from './TransferPaymentFields'

const BY_LINK = 'Se generará un enlace de pago para cobrar por WhatsApp'
const BROKEN = 'El cobro con Devolada tiene fallas; un administrador verificará la transferencia'
const MANUAL = 'En verificación · los boletos se envían al confirmar el pago'

const connection = (status: OrganizationDevoladaSummary['status']): OrganizationDevoladaSummary => ({
  status,
  mode: status === 'connected' || status === 'broken' ? 'test' : null,
})

/** The page owns the reference; the harness stands in for it. */
function Fields(props: Partial<TransferPaymentFieldsProps>) {
  const [reference, setReference] = useState('')
  return (
    <TransferPaymentFields
      referenceRequired
      reference={reference}
      onReferenceChange={setReference}
      {...props}
    />
  )
}

const referenceField = () => screen.queryByRole('textbox', { name: /Referencia de la transferencia/ })

describe('TransferPaymentFields', () => {
  // T058 — PR 1 kept an apartado deposit on the manual path, so this component took a `deposit`
  // flag that brought the field back. Deposits now get their own enlace, so the flag is gone: the
  // connection alone decides, for a full sale, a deposit and a balance (SettleSheet) alike.
  it('connected, a transfer is collected by enlace — a full sale or an apartado deposit: no reference field', async () => {
    const { container } = renderWithProviders(<Fields devolada={connection('connected')} />)
    expect(referenceField()).not.toBeInTheDocument()
    expect(screen.getByText(BY_LINK)).toBeInTheDocument()
    expect(screen.queryByText(MANUAL)).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('a broken connection keeps the reference and its rules, and says why', async () => {
    const { container } = renderWithProviders(<Fields devolada={connection('broken')} />)
    const field = referenceField()
    expect(field).toBeInTheDocument()
    expect(screen.getByText(BROKEN)).toBeInTheDocument()
    expect(screen.getByText(MANUAL)).toBeInTheDocument()
    expect(screen.queryByText(BY_LINK)).not.toBeInTheDocument()

    await userEvent.type(field!, 'ABC')
    expect(screen.getByText('Captura al menos 4 caracteres.')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  describe('without Devolada, the US-A88 rules', () => {
    it.each([
      ['never connected', undefined],
      ['not_connected', connection('not_connected')],
      ['disconnected', connection('disconnected')],
    ])('%s: the reference is asked for, and nothing names Devolada', (_, devolada) => {
      renderWithProviders(<Fields devolada={devolada} />)
      expect(referenceField()).toBeInTheDocument()
      expect(screen.getByText(MANUAL)).toBeInTheDocument()
      expect(screen.queryByText(BY_LINK)).not.toBeInTheDocument()
      expect(screen.queryByText(BROKEN)).not.toBeInTheDocument()
    })

    it('a required reference refuses a partial one, and takes four characters', async () => {
      const { container } = renderWithProviders(<Fields />)
      const field = screen.getByRole('textbox', { name: 'Referencia de la transferencia' })

      await userEvent.type(field, 'ABC')
      expect(field).toBeInvalid()
      expect(screen.getByText('Captura al menos 4 caracteres.')).toBeInTheDocument()

      await userEvent.type(field, 'D')
      expect(field).toBeValid()
      expect(
        screen.getByText('Número o folio del comprobante — el administrador lo verifica.'),
      ).toBeInTheDocument()
      await expectNoA11yViolations(container)
    })

    it('an optional reference says so, and still refuses a partial one', async () => {
      renderWithProviders(<Fields referenceRequired={false} />)
      const field = screen.getByRole('textbox', {
        name: 'Referencia de la transferencia (opcional)',
      })
      expect(field).toBeValid()

      await userEvent.type(field, 'ABC')
      expect(field).toBeInvalid()
      expect(screen.getByText('Captura al menos 4 caracteres.')).toBeInTheDocument()
    })
  })
})
