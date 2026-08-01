import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../test/renderWithProviders'
import { MoneyText } from './MoneyText'

// Normalise the space Intl puts inside currency output — it is a NBSP/NNBSP depending on ICU
// build, and asserting the exact codepoint makes the suite fail on a Node upgrade rather than on
// a real regression.
const money = (el: HTMLElement) => el.textContent?.replace(/[\u00A0\u202F]/g, ' ')

describe('MoneyText', () => {
  it('renders minor units as MXN currency', () => {
    renderWithProviders(<MoneyText cents={150000} />)
    expect(money(screen.getByText(/1,500/))).toBe('$1,500.00')
  })

  it('renders zero and sub-peso amounts without dropping precision', () => {
    const { rerender } = renderWithProviders(<MoneyText cents={0} />)
    expect(money(screen.getByText(/0\.00/))).toBe('$0.00')

    rerender(<MoneyText cents={5} />)
    expect(money(screen.getByText(/0\.05/))).toBe('$0.05')
  })

  // The theme is built with `cssVariables: true`, so a computed colour in jsdom is the CSS custom
  // property, never a resolved rgb. Asserting the variable is the better test anyway: it proves the
  // SEMANTIC MAPPING (this figure means "owed") without restating a hex whose authority is
  // .design/design-system/DESIGN_TOKENS.md — docs/PROCESS.md § one source.
  it('derives the semantic colour from the sign only when `signed` is set', () => {
    const { rerender } = renderWithProviders(<MoneyText cents={-250000} signed />)
    expect(screen.getByText(/2,500/)).toHaveStyle({ color: 'var(--mui-palette-error-main)' })

    rerender(<MoneyText cents={250000} signed />)
    expect(screen.getByText(/2,500/)).toHaveStyle({ color: 'var(--mui-palette-success-main)' })

    // Unsigned is neutral ink, whatever the sign: money colour is meaning, not arithmetic.
    rerender(<MoneyText cents={-250000} />)
    expect(screen.getByText(/2,500/)).toHaveStyle({ color: 'var(--mui-palette-text-primary)' })
  })

  it('never renders money in the teal accent — the accent is action, money is meaning', () => {
    const { rerender } = renderWithProviders(<MoneyText cents={5000} semantic="positive" />)
    for (const semantic of ['positive', 'negative', 'neutral'] as const) {
      rerender(<MoneyText cents={5000} semantic={semantic} />)
      expect(screen.getByText(/50\.00/).getAttribute('style') ?? '').not.toMatch(/primary/)
    }
  })

  it('shows a magnitude when `absolute` is set, keeping the semantic independent', () => {
    renderWithProviders(<MoneyText cents={-250000} absolute semantic="negative" />)
    expect(money(screen.getByText(/2,500/))).toBe('$2,500.00')
    expect(screen.queryByText(/-/)).not.toBeInTheDocument()
  })

  it('announces the amount with its label when `srLabel` is given', () => {
    renderWithProviders(<MoneyText cents={98700} srLabel="Saldo a entregar" />)
    expect(screen.getByLabelText(/Saldo a entregar/)).toBeInTheDocument()
  })

  it('carries the tabular-figures class so digits do not jitter between renders', () => {
    renderWithProviders(<MoneyText cents={100} />)
    expect(screen.getByText(/1\.00/)).toHaveClass('numeric')
  })
})
