// devolada-transfer-verification US1 — the payment link card: its label, its amount, its expiry
// while it is open, and «Cobrar por WhatsApp»; or why there is no enlace (contracts/turistear-api.md
// § Labels, § Action copy, § The WhatsApp message for a link; research D16).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen, userEvent } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aPaymentLink } from '../../../test/handlers/devolada'
import { PAYMENT_LINK_LABEL_COPY } from '../copy'
import type { PaymentLinkLabel, PaymentLinkView } from '../types'
import { PaymentLinkCard } from './PaymentLinkCard'
import { PaymentLinkStatusChip } from './PaymentLinkStatusChip'

// 2026-08-01 12:00 in Mexico City.
const NOW = Date.parse('2026-08-01T18:00:00Z')
const message = {
  folio: {
    id: 'folio-1',
    customer_name: 'Ana',
    customer_phone: '9981234567',
    total: 125_000,
    amount_paid: 125_000,
    lines: [],
  },
  agentName: 'Luis',
  orgName: 'Turistear Ya',
  timezone: 'America/Mexico_City',
  nowMs: NOW,
}
const link = (over: Partial<PaymentLinkView> = {}) =>
  aPaymentLink({
    amount: 125_000,
    // 20:30 the same day, org-local.
    expires_at: Date.parse('2026-08-02T02:30:00Z') / 1000,
    ...over,
  }) as PaymentLinkView

afterEach(() => vi.restoreAllMocks())

describe('PaymentLinkStatusChip — one chip per label, icon and text', () => {
  it.each(Object.keys(PAYMENT_LINK_LABEL_COPY) as PaymentLinkLabel[])('%s', (label) => {
    const { container } = renderWithProviders(<PaymentLinkStatusChip label={label} />)
    expect(screen.getByText(PAYMENT_LINK_LABEL_COPY[label].text)).toBeInTheDocument()
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('never says «liga», «link» or «validar»', () => {
    for (const { text } of Object.values(PAYMENT_LINK_LABEL_COPY)) {
      expect(text).not.toMatch(/\bliga\b|\blink\b|validar/i)
    }
  })
})

describe('PaymentLinkCard', () => {
  it('an open link shows its amount, its expiry and «Cobrar por WhatsApp»', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    const { container } = renderWithProviders(<PaymentLinkCard link={link()} message={message} />)
    expect(screen.getByText('Enlace de pago')).toBeInTheDocument()
    expect(screen.getByText('Esperando pago')).toBeInTheDocument()
    expect(screen.getByText('Vence hoy a las 20:30')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Cobrar por WhatsApp' }))
    const url = decodeURIComponent(String(opened.mock.calls[0]![0]))
    expect(url).toContain('https://wa.me/52')
    expect(url).toContain('https://link.devoladapago.com/p/kq7m2x9d4tbn3wpa')
    expect(url).toContain('$1,250.00')
    await expectNoA11yViolations(container)
  })

  it('once the link is not open: no expiry line and no WhatsApp action', async () => {
    const { container } = renderWithProviders(
      <PaymentLinkCard link={link({ state: 'paid', label: 'confirmed' })} message={message} />,
    )
    expect(screen.getByText('Pago confirmado')).toBeInTheDocument()
    expect(screen.queryByText(/^Vence/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cobrar por WhatsApp' })).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('a link that could not be created says an admin will verify the transfer', async () => {
    const { container } = renderWithProviders(
      <PaymentLinkCard link={link({ state: 'failed', label: 'link_failed' })} message={message} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No se pudo crear el enlace de pago; un administrador verificará la transferencia',
    )
    expect(screen.getByText('Sin enlace de pago — verificar a mano')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cobrar por WhatsApp' })).not.toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('too little time to collect by enlace has its own copy', () => {
    renderWithProviders(
      <PaymentLinkCard
        link={link({ state: 'failed', label: 'link_failed' })}
        error="PAYMENT_LINK_TOO_SHORT"
        message={message}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Ya no hay tiempo para cobrar con enlace; un administrador verificará la transferencia',
    )
  })

  it('a phone WhatsApp cannot reach disables the action', () => {
    renderWithProviders(
      <PaymentLinkCard
        link={link()}
        message={{ ...message, folio: { ...message.folio, customer_phone: 'no digits here' } }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Cobrar por WhatsApp' })).toBeDisabled()
  })
})
