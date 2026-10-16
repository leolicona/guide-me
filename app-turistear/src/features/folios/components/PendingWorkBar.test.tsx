// devolada-transfer-verification US1 — the pending-work bar's «Por verificar» is `porVerificarCount`:
// the number the admin's Ventas badge and Hoy show, without the sales Devolada is resolving
// (research D14; contracts/turistear-api.md § Reads). Hoy renders this same bar, and the badge in
// AppLayout reads the same helper, so the three cannot disagree.
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen, userEvent } from '../../../test/renderWithProviders'
import { expectNoA11yViolations } from '../../../test/axe'
import { aFolioCounts } from '../../../test/handlers/folios'
import type { FolioCounts } from '../../../services/foliosService'
import { porVerificarCount } from '../folioFacets'
import { PendingWorkBar } from './PendingWorkBar'

const counts = (over: Partial<FolioCounts> = {}) => aFolioCounts(over) as FolioCounts

describe('devolada-transfer-verification US1 — «Por verificar» counts the admin’s work only', () => {
  it('shows verification − verification_auto, the number the badge and Hoy show', async () => {
    const c = counts({ verification: 5, verification_auto: 2 })
    const { container } = renderWithProviders(
      <PendingWorkBar counts={c} active={[]} onToggle={() => {}} />,
    )

    expect(porVerificarCount(c)).toBe(3)
    expect(screen.getByRole('button', { name: '3 Por verificar' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('a day whose every pending transfer Devolada is resolving shows no «Por verificar» pill', async () => {
    const { container } = renderWithProviders(
      <PendingWorkBar
        counts={counts({ verification: 2, verification_auto: 2, refunds: 1 })}
        active={[]}
        onToggle={() => {}}
      />,
    )

    // D5 — a zero costs no pixels, and here zero is the truth: nobody has to verify anything.
    expect(screen.queryByRole('button', { name: /Por verificar/ })).toBeNull()
    expect(screen.getByRole('button', { name: '1 Reembolso' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('without Devolada the pill reads every pending verification, as before', async () => {
    const { container } = renderWithProviders(
      <PendingWorkBar counts={counts({ verification: 4 })} active={[]} onToggle={() => {}} />,
    )

    expect(screen.getByRole('button', { name: '4 Por verificar' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('tapping it applies the facet that lists exactly those sales', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <PendingWorkBar
        counts={counts({ verification: 3, verification_auto: 1 })}
        active={['por_verificar']}
        onToggle={onToggle}
      />,
    )

    const pill = screen.getByRole('button', { name: '2 Por verificar' })
    expect(pill).toHaveAttribute('aria-pressed', 'true')
    await user.click(pill)
    expect(onToggle).toHaveBeenCalledWith('por_verificar')
    await expectNoA11yViolations(container)
  })
})
