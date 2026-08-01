import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../test/renderWithProviders'
import { expectNoA11yViolations } from '../test/axe'
import { SectionCard } from './SectionCard'

describe('SectionCard', () => {
  it('renders its children', () => {
    renderWithProviders(<SectionCard>Contenido</SectionCard>)
    expect(screen.getByText('Contenido')).toBeInTheDocument()
  })

  it('renders a string title as a heading, so screens have a real outline', () => {
    renderWithProviders(<SectionCard title="Resumen del turno">…</SectionCard>)
    expect(screen.getByRole('heading', { name: 'Resumen del turno' })).toBeInTheDocument()
  })

  it('passes a non-string title through untouched, without wrapping it in a heading', () => {
    renderWithProviders(
      <SectionCard title={<span data-testid="custom">Personalizado</span>}>…</SectionCard>,
    )
    expect(screen.getByTestId('custom')).toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('renders the top-right action alongside the title', () => {
    renderWithProviders(
      <SectionCard title="Agentes" action={<button type="button">Invitar</button>}>
        …
      </SectionCard>,
    )
    expect(screen.getByRole('button', { name: 'Invitar' })).toBeInTheDocument()
  })

  // Structure-first: the resting surface earns its edge from a hairline border, not a shadow —
  // a shadow disappears in direct sunlight, which is where this app is used.
  it('casts no resting shadow', () => {
    const { container } = renderWithProviders(<SectionCard>…</SectionCard>)
    const card = container.querySelector('.MuiPaper-root')
    const shadow = getComputedStyle(card as Element).boxShadow
    expect(shadow === '' || shadow === 'none').toBe(true)
  })

  it('has no accessibility violations', async () => {
    const { container } = renderWithProviders(
      <SectionCard title="Resumen" action={<button type="button">Ver</button>}>
        Contenido
      </SectionCard>,
    )
    await expectNoA11yViolations(container)
  })
})
