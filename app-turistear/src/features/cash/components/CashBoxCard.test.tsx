import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { CashBoxCard } from './CashBoxCard'
import { SalesSummaryCard } from './SalesSummaryCard'
import { CommissionsCard } from './CommissionsCard'
import type { AgentBalance, SalesBreakdown, CommissionBreakdown } from '../types'

const aBalance = (over: Partial<AgentBalance> = {}): AgentBalance => ({
  carry_forward: 0,
  cash_collected: 250_000,
  commission_total: 25_000,
  expense_total: 0,
  pending_drops_total: 0,
  payouts_total: 0,
  balance: 225_000,
  last_drop: null,
  expenses: [],
  drops: [],
  drops_truncated: false,
  pending_acknowledgments: [],
  pending_acknowledgments_count: 0,
  sales: aSales(),
  commissions: aCommissions(),
  ...over,
})

function aSales(over: Partial<SalesBreakdown> = {}): SalesBreakdown {
  return {
    total: 250_000,
    cash: 250_000,
    electronic: 0,
    by_method: { card: 0, transfer: 0, link: 0 },
    cash_count: 2,
    electronic_count: 0,
    ...over,
  }
}

function aCommissions(over: Partial<CommissionBreakdown> = {}): CommissionBreakdown {
  return { total: 25_000, cash: 25_000, electronic: 0, ...over }
}

describe('CashBoxCard — the hand-in call to action', () => {
  it('offers the hand-in when there is cash to hand in', () => {
    renderWithProviders(<CashBoxCard balance={aBalance()} onRegisterDrop={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Entregar efectivo' })).toBeInTheDocument()
  })

  // The page's single teal accent must not open onto a dialog whose every control is disabled.
  // The admin's own caja sat in exactly this state at $0.00 (design review, Should Fix 9).
  it('does not offer it at a zero balance — it would open a dialog that can only be cancelled', () => {
    renderWithProviders(
      <CashBoxCard balance={aBalance({ balance: 0 })} onRegisterDrop={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'Entregar efectivo' })).not.toBeInTheDocument()
    expect(screen.getByText('Nada por entregar por ahora.')).toBeInTheDocument()
  })

  // Cash held, but every peso of it already pledged to a drop awaiting confirmation. The API caps
  // the hand-in at the same figure, so the button could only ever be refused.
  it('does not offer it when the whole balance is already pledged to a pending drop', () => {
    renderWithProviders(
      <CashBoxCard
        balance={aBalance({ balance: 100_000, pending_drops_total: 100_000 })}
        onRegisterDrop={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Entregar efectivo' })).not.toBeInTheDocument()
  })

  // The company owing the seller is not a hand-in situation either.
  it('does not offer it on a negative balance', () => {
    renderWithProviders(
      <CashBoxCard balance={aBalance({ balance: -50_000 })} onRegisterDrop={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'Entregar efectivo' })).not.toBeInTheDocument()
    expect(screen.getByText('La empresa te debe')).toBeInTheDocument()
  })
})

// These three cards ARE the caja: the cash box, the shift's sales, the commissions earned. Their
// labels look like overlines, and looking like something is not being it — all three rendered as
// `<span>`, so the page's three most important regions contributed nothing to the heading outline
// and a screen-reader user navigating by heading skipped straight past the money (design review,
// Must Fix 5).
describe('the caja cards are regions, not floating text', () => {
  it('names the cash box with a heading', () => {
    renderWithProviders(<CashBoxCard balance={aBalance()} onRegisterDrop={vi.fn()} />)
    expect(
      screen.getByRole('heading', { level: 2, name: 'Efectivo por entregar' }),
    ).toBeInTheDocument()
  })

  it('renames that heading when the company is the one who owes', () => {
    renderWithProviders(
      <CashBoxCard balance={aBalance({ balance: -50_000 })} onRegisterDrop={vi.fn()} />,
    )
    expect(
      screen.getByRole('heading', { level: 2, name: 'La empresa te debe' }),
    ).toBeInTheDocument()
  })

  it('names the sales summary with a heading', () => {
    renderWithProviders(<SalesSummaryCard sales={aSales()} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Ventas del turno' })).toBeInTheDocument()
  })

  it('names the commissions with a heading', () => {
    renderWithProviders(<CommissionsCard commissions={aCommissions()} />)
    expect(
      screen.getByRole('heading', { level: 2, name: 'Comisiones ganadas' }),
    ).toBeInTheDocument()
  })
})

// Money reads first, in tabular figures — the split lines are columns of money and were 14–16px
// proportional `Typography`, so the digits did not align down the column (design review, Should
// Fix 6). `MoneyText` carries the `.numeric` class that makes them tabular.
describe('every figure goes through the money primitive', () => {
  it('makes the cash / electronic split tabular', () => {
    const { container } = renderWithProviders(
      <SalesSummaryCard sales={aSales({ total: 300_000, cash: 250_000, electronic: 50_000 })} />,
    )
    expect(container.querySelectorAll('.numeric').length).toBeGreaterThanOrEqual(3)
  })

  it('makes the commission split tabular', () => {
    const { container } = renderWithProviders(
      <CommissionsCard commissions={aCommissions({ total: 30_000, cash: 25_000, electronic: 5_000 })} />,
    )
    expect(container.querySelectorAll('.numeric').length).toBeGreaterThanOrEqual(3)
  })
})
