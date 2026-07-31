import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../test/renderWithProviders'
import { expectNoA11yViolations } from '../test/axe'
import { StatusChip } from './StatusChip'

// The design system's hardest rule: STATE IS NEVER COLOUR ALONE. Every preset must ship an icon,
// because a colour-blind cashier in the sun has only the glyph and the word. This file is what
// enforces it — a new preset added without an icon fails here.
const PRESETS = [
  'paid',
  'available',
  'active',
  'confirmed',
  'booking',
  'pending',
  'expiring',
  'cancelled',
  'dispute',
  'full',
  'suspended',
] as const

describe('StatusChip', () => {
  it.each(PRESETS)('pairs the %s preset with an icon, never colour alone', (status) => {
    const { container } = renderWithProviders(<StatusChip status={status} />)
    expect(container.querySelector('.MuiChip-icon')).toBeInTheDocument()
  })

  it.each(PRESETS)('gives the %s preset a non-empty Spanish label', (status) => {
    renderWithProviders(<StatusChip status={status} />)
    expect(screen.getByText(/\S/)).toBeInTheDocument()
  })

  it('resolves the canonical labels the rest of the app relies on', () => {
    const cases: [string, string][] = [
      ['paid', 'Pagado'],
      ['booking', 'Apartado'],
      ['cancelled', 'Cancelado'],
      ['dispute', 'En disputa'],
      ['suspended', 'Suspendido'],
    ]
    for (const [status, label] of cases) {
      const { unmount } = renderWithProviders(<StatusChip status={status} />)
      expect(screen.getByText(label)).toBeInTheDocument()
      unmount()
    }
  })

  it('falls back to the raw status as its own label for an unknown key', () => {
    renderWithProviders(<StatusChip status="algo_nuevo" />)
    expect(screen.getByText('algo_nuevo')).toBeInTheDocument()
  })

  it('renders an unknown status as neutral — an unmapped state must not claim to be an error', () => {
    const { container } = renderWithProviders(<StatusChip status="algo_nuevo" />)
    const chip = container.querySelector('.MuiChip-root')
    // The neutral tone's foreground token, not the error one.
    expect(chip).toHaveStyle({ color: 'var(--color-text-secondary, #475569)' })
  })

  it('lets a caller override the label without losing the preset icon', () => {
    const { container } = renderWithProviders(<StatusChip status="paid" label="Liquidado" />)
    expect(screen.getByText('Liquidado')).toBeInTheDocument()
    expect(container.querySelector('.MuiChip-icon')).toBeInTheDocument()
  })

  // Teal is the action accent. A status pill carrying it would tell a cashier that a cancelled
  // folio is something to tap.
  it.each(PRESETS)('never tints the %s preset with the teal accent', (status) => {
    const { container } = renderWithProviders(<StatusChip status={status} />)
    const style = container.querySelector('.MuiChip-root')?.getAttribute('style') ?? ''
    expect(style).not.toMatch(/primary|0F766E/i)
  })

  it('has no accessibility violations', async () => {
    const { container } = renderWithProviders(<StatusChip status="paid" />)
    await expectNoA11yViolations(container)
  })
})
