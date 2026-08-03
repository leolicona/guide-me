import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../test/renderWithProviders'
import { expectNoA11yViolations } from '../test/axe'
import { AlertCard } from './AlertCard'

describe('AlertCard', () => {
  it('announces itself to assistive tech — it blocks attention until resolved', () => {
    renderWithProviders(<AlertCard title="Tienes un depósito pendiente de firma" />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it.each(['warning', 'error', 'info'] as const)('pairs the %s tone with an icon', (tone) => {
    const { container } = renderWithProviders(<AlertCard tone={tone} title="Aviso" />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders the supporting detail and actions when given', () => {
    renderWithProviders(
      <AlertCard title="Depósito pendiente" actions={<button type="button">Firmar</button>}>
        Firma o disputa antes del cierre.
      </AlertCard>,
    )
    expect(screen.getByText(/Firma o disputa/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Firmar' })).toBeInTheDocument()
  })

  it('renders a title-only card without an empty body', () => {
    renderWithProviders(<AlertCard title="Sólo título" />)
    expect(screen.getByText('Sólo título')).toBeInTheDocument()
    expect(screen.getByRole('alert').textContent).toBe('Sólo título')
  })

  it('never uses the teal accent — attention is a functional colour, not the brand one', () => {
    for (const tone of ['warning', 'error', 'info'] as const) {
      const { container, unmount } = renderWithProviders(<AlertCard tone={tone} title="Aviso" />)
      const style = screen.getByRole('alert').getAttribute('style') ?? ''
      expect(style, tone).not.toMatch(/0F766E|primary/i)
      expect(container).toBeTruthy()
      unmount()
    }
  })

  it('has no accessibility violations, actions included', async () => {
    const { container } = renderWithProviders(
      <AlertCard tone="error" title="No se pudo cobrar" actions={<button type="button">Reintentar</button>}>
        Revisa la conexión.
      </AlertCard>,
    )
    await expectNoA11yViolations(container)
  })
})
