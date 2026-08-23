import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { anAgentBalance, aBalanceRow } from '../../../test/handlers/cash'
import { renderWithProviders, screen, waitFor } from '../../../test/renderWithProviders'
import { expectHeadingOutline } from '../../../test/axe'
import { CurrentUserProvider } from '../../auth/CurrentUserContext'
import type { UserPayload, UserRole } from '../../auth/types'
import { BalanceScreen, type CajaSurface } from './BalanceScreen'

// The caja was ONE payload rendered by TWO hand-written screens, and they drifted: an admin could
// file a hand-in and never see it again, their negative-balance card carried a poorer breakdown
// than the seller's, and their reconciliation offered a `Gastos` row for a capability the API
// answers 403 to. This file is what stops it happening a second time.
//
// The parity assertion is deliberately two-sided. Asserting only that a block is PRESENT on both
// surfaces proves half of parity; the half that broke was a block quietly ABSENT on one of them.

const aUser = (role: UserRole = 'agent'): UserPayload => ({
  userId: 'u1',
  name: 'Ana Ramírez',
  email: 'ana@x.com',
  role,
  organizationId: 'o1',
  affiliateCompanyId: role === 'affiliate' ? 'aff-1' : null,
})

// The org read behind `useOrgDateFormatter`. In `beforeEach`, not `beforeAll`: MSW resets handlers
// after every test, so a `beforeAll` registration survives exactly one of them.
beforeEach(() => {
  server.use(
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' },
      }),
    ),
  )
})

// The oversight block's count is DERIVED from the team's balances (`usePendingDropCount` sums
// `pending_drops_count` over `/api/cash/balances`) — there is no count endpoint to stub.
const withTeamPending = (count: number) =>
  server.use(
    http.get('/api/cash/balances', () =>
      HttpResponse.json({ balances: [aBalanceRow({ pending_drops_count: count })] }),
    ),
  )

const withBalance = (over: Record<string, unknown> = {}) =>
  server.use(
    http.get('/api/cash/me', () => HttpResponse.json({ balance: anAgentBalance(over) })),
  )

const renderScreen = (surface: CajaSurface, role?: UserRole) =>
  renderWithProviders(
    <CurrentUserProvider value={aUser(role ?? (surface === 'admin' ? 'admin' : 'agent'))}>
      <h1>Caja</h1>
      <BalanceScreen surface={surface} />
    </CurrentUserProvider>,
  )

const aDropRow = (over: Record<string, unknown> = {}) => ({
  id: 'drop-1',
  source: 'agent',
  amount: 20_000,
  amount_requested: null,
  balance_before: 100_000,
  status: 'pending',
  acknowledgment: 'not_required',
  acknowledged_at: null,
  ack_due_at: null,
  ack_note: null,
  ack_resolved_by: null,
  note: 'Entrega de media tarde',
  reviewed_by: null,
  reviewed_at: null,
  review_note: null,
  created_at: 1_800_000_000,
  ...over,
})

// ── What BOTH surfaces must show — the "never which numbers are shown" half of D4 ──────────────

describe.each(['self', 'admin'] as const)('BalanceScreen — %s', (surface) => {
  it('shows the cash box, the shift blocks and the hand-in history', async () => {
    withBalance({ drops: [aDropRow({ status: 'confirmed' })] })
    renderScreen(surface)

    // S-1 — the admin's own Entregas list is the block that simply did not exist for them.
    expect(await screen.findByRole('heading', { level: 2, name: 'Entregas' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Efectivo por entregar' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Ventas del turno' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Comisiones ganadas' })).toBeInTheDocument()
    expect(screen.getByText('Entrega de media tarde', { exact: false })).toBeInTheDocument()
  })

  // S-7 — the admin's sales/commissions used to be gated on `total !== 0`, so the same quiet shift
  // rendered two different screen lengths. A zero shift IS information: «no he vendido nada hoy».
  it('shows the shift blocks even when the shift is empty', async () => {
    withBalance({
      sales: { total: 0, cash: 0, electronic: 0, by_method: { card: 0, transfer: 0, link: 0 }, cash_count: 0, electronic_count: 0 },
      commissions: { total: 0, cash: 0, electronic: 0 },
    })
    renderScreen(surface)
    expect(await screen.findByRole('heading', { level: 2, name: 'Ventas del turno' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Comisiones ganadas' })).toBeInTheDocument()
  })

  // S-13 — the screen-level guard. Per-card assertions could not see a skipped level.
  it('keeps a navigable heading outline', async () => {
    withBalance()
    renderScreen(surface)
    await screen.findByRole('heading', { level: 2, name: 'Efectivo por entregar' })
    expectHeadingOutline('Caja')
  })

  // S-14 — money reads first, in tabular figures, wherever it appears.
  it('renders every figure through the money primitive', async () => {
    withBalance({ drops: [aDropRow()] })
    const { container } = renderScreen(surface)
    await screen.findByRole('heading', { level: 2, name: 'Entregas' })
    expect(container.querySelectorAll('.numeric').length).toBeGreaterThan(4)
  })

  it('names the negative balance and offers no hand-in', async () => {
    withBalance({ balance: -50_000 })
    renderScreen(surface)
    expect(
      await screen.findByRole('heading', { level: 2, name: 'La empresa te debe' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Entregar efectivo' })).not.toBeInTheDocument()
  })
})

// ── What may differ — and nothing else (S-12) ─────────────────────────────────────────────────

describe('BalanceScreen — the capability line', () => {
  // S-3 / S-5 — `/me/expenses` is `agent`-only. The row for a denied capability is the defect the
  // affiliate was spared and the admin was not.
  it('offers expenses to an agent — the card AND the breakdown row', async () => {
    withBalance()
    renderScreen('self', 'agent')
    expect(await screen.findByRole('heading', { level: 2, name: 'Gastos' })).toBeInTheDocument()
    // Two matches: the card's heading and the reconciliation row inside «¿Cómo se calcula?».
    // This is what makes the two absence assertions below non-vacuous — it proves the query
    // reaches inside the collapsed disclosure, which MUI keeps mounted.
    expect(screen.getAllByText('Gastos')).toHaveLength(2)
  })

  it('offers them to neither an affiliate nor an admin', async () => {
    withBalance()
    const affiliate = renderScreen('self', 'affiliate')
    await screen.findByRole('heading', { level: 2, name: 'Entregas' })
    expect(screen.queryByRole('heading', { level: 2, name: 'Gastos' })).not.toBeInTheDocument()
    affiliate.unmount()

    withBalance()
    renderScreen('admin')
    await screen.findByRole('heading', { level: 2, name: 'Entregas' })
    expect(screen.queryByRole('heading', { level: 2, name: 'Gastos' })).not.toBeInTheDocument()
  })

  // The breakdown row is the half that was invisible: the card was already hidden for an
  // affiliate, but `showExpenses` defaulted true, so `Gastos −$0.00` stayed in the reconciliation.
  it('drops the Gastos row from the breakdown too, not just the card', async () => {
    withBalance({ expense_total: 0 })
    renderScreen('admin')
    await screen.findByRole('heading', { level: 2, name: 'Efectivo por entregar' })
    expect(screen.queryByText('Gastos')).not.toBeInTheDocument()
  })

  // S-6 — a screen that looks identical while behaving differently is worse than two screens.
  it('states self-authorization on the admin surface only', async () => {
    withBalance()
    const self = renderScreen('self')
    await screen.findByRole('heading', { level: 2, name: 'Efectivo por entregar' })
    expect(screen.queryByText('Auto-confirmado')).not.toBeInTheDocument()
    self.unmount()

    withBalance()
    renderScreen('admin')
    expect(await screen.findByText('Auto-confirmado')).toBeInTheDocument()
  })

  // D13 — the payout endpoint is admin-guarded; offering it to a seller would 403.
  it('offers the payout only to the admin, and only when the company owes them', async () => {
    withBalance({ balance: -50_000 })
    const self = renderScreen('self')
    await screen.findByRole('heading', { level: 2, name: 'La empresa te debe' })
    expect(screen.queryByRole('button', { name: 'Registrar pago' })).not.toBeInTheDocument()
    self.unmount()

    withBalance({ balance: -50_000 })
    renderScreen('admin')
    expect(await screen.findByRole('button', { name: 'Registrar pago' })).toBeInTheDocument()
  })

  it('offers no payout to an admin who is not owed anything', async () => {
    withBalance({ balance: 100_000 })
    renderScreen('admin')
    await screen.findByRole('heading', { level: 2, name: 'Efectivo por entregar' })
    expect(screen.queryByRole('button', { name: 'Registrar pago' })).not.toBeInTheDocument()
  })

  // An admin owes no signature: their own moves are self-authorized, so the endpoint never mints
  // an obligation for them — and the acknowledge/dispute routes are `agentOrAffiliate` anyway.
  it('shows the signature queue to the seller only', async () => {
    const ack = [
      {
        id: 'drop-9',
        source: 'admin',
        amount: 15_000,
        amount_requested: null,
        balance_before: 100_000,
        note: 'Cobro directo en recepción',
        reviewed_at: 1_800_000_000,
        ack_due_at: 1_800_090_000,
      },
    ]
    withBalance({ pending_acknowledgments: ack, pending_acknowledgments_count: 1 })
    const self = renderScreen('self')
    expect(await screen.findByText('Pendientes de firma')).toBeInTheDocument()
    self.unmount()

    withBalance({ pending_acknowledgments: ack, pending_acknowledgments_count: 1 })
    renderScreen('admin')
    await screen.findByRole('heading', { level: 2, name: 'Efectivo por entregar' })
    expect(screen.queryByText('Pendientes de firma')).not.toBeInTheDocument()
  })

  // S-21 / D17 — the FOURTH gate, and the one deliberately added to D4's list of three. Once
  // «Caja» means MY caja for the admin too, their oversight work needs a door, and their own
  // screen is where they already are.
  it('shows the team’s pending work to the admin, and to nobody else', async () => {
    withTeamPending(3)
    withBalance()
    const self = renderScreen('self')
    await screen.findByRole('heading', { level: 2, name: 'Efectivo por entregar' })
    expect(screen.queryByText(/esperan tu confirmación/)).not.toBeInTheDocument()
    self.unmount()

    withTeamPending(3)
    withBalance()
    renderScreen('admin')
    expect(
      await screen.findByText('3 entregas del equipo esperan tu confirmación'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ver caja del equipo' })).toHaveAttribute(
      'href',
      '/cash',
    )
  })

  // Nothing waiting is not a thing to announce.
  it('hides that block when the team owes the admin nothing', async () => {
    withTeamPending(0)
    withBalance()
    renderScreen('admin')
    await screen.findByRole('heading', { level: 2, name: 'Efectivo por entregar' })
    expect(screen.queryByText(/confirmación/)).not.toBeInTheDocument()
  })

  // An admin's own drop is born `confirmed`, so there is never a pending one to cancel.
  it('lets the seller cancel a pending hand-in, and never the admin', async () => {
    withBalance({ drops: [aDropRow({ status: 'pending' })] })
    const self = renderScreen('self')
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
    self.unmount()

    withBalance({ drops: [aDropRow({ status: 'pending' })] })
    renderScreen('admin')
    await screen.findByRole('heading', { level: 2, name: 'Entregas' })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument(),
    )
  })
})
