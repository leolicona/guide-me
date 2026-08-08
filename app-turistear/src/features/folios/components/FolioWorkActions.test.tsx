import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import userEvent from '@testing-library/user-event'
import { FolioWorkActions } from './FolioWorkActions'
import type { FolioCancellationRequest, FolioDetail } from '../types'

// US-A84 (D14) — the work a folio needs, on the folio itself.
//
// The duplication case below was found by RENDERING, not by reasoning: the live request was shown
// once as work and again as the first row of the history, so one request appeared twice on one
// screen with the same reason under it. jsdom cannot see layout, but it can see that.

const req = (over: Partial<FolioCancellationRequest>): FolioCancellationRequest => ({
  id: 'r1',
  status: 'pending',
  reason: 'Nos cambió el vuelo',
  resolution_note: null,
  resolved_by: null,
  resolved_at: null,
  created_at: 1_700_000_000,
  ...over,
})

const folio = (over: Partial<FolioDetail> = {}): FolioDetail =>
  ({ id: 'f1', status: 'paid', payment_verification: 'not_required', ...over }) as FolioDetail

// The refund sheet lives with the page (its success path opens the receipt composer); the card
// only signals. Tests that don't press the button share this no-op.
const renderWork = (f: FolioDetail, onConfirmRefund: () => void = () => {}) =>
  renderWithProviders(<FolioWorkActions folio={f} onConfirmRefund={onConfirmRefund} />)

describe('US-A84 — the folio detail carries its own work', () => {
  it('shows a live request ONCE — as work, not also as history', () => {
    renderWork(folio({ folio_requests: [req({})] }))

    expect(screen.getByText('El cliente pidió cancelar')).toBeInTheDocument()
    // The history card must not repeat the request the card above is already asking about.
    expect(screen.queryByText('Historial de solicitudes')).toBeNull()
    expect(screen.getAllByText(/Nos cambió el vuelo/)).toHaveLength(1)
  })

  it('renders NOTHING for a folio whose only requests are resolved — the timeline owns history', () => {
    const { container } = renderWork(
      folio({
        folio_requests: [
          req({ id: 'r2', status: 'rejected', resolution_note: 'Fuera de ventana' }),
        ],
      }),
    )

    // The rejected petition's ONLY surface is now its derived row in FolioTimeline — this
    // component carries WORK, and resolved history is not work.
    expect(container).toBeEmptyDOMElement()
  })

  it('offers verification only while the folio is alive', () => {
    const { unmount } = renderWork(folio({ payment_verification: 'pending' }))
    expect(screen.getByRole('button', { name: 'Verificar' })).toBeInTheDocument()
    // `Rechazar pago` cancels the sale and claws back commission, so it lives HERE and never on the
    // list card (D14).
    expect(screen.getByRole('button', { name: 'Rechazar pago' })).toBeInTheDocument()
    unmount()

    // A rejected payment cancels the folio and leaves its stale 'pending' flag behind (US-A67).
    renderWork(folio({ status: 'cancelled', payment_verification: 'pending' }))
    expect(screen.queryByRole('button', { name: 'Verificar' })).toBeNull()
  })

  it('renders nothing at all when the folio owes no work', () => {
    const { container } = renderWork(folio())
    expect(container).toBeEmptyDOMElement()
  })
})

// US-AG52 — the review surface must know WHAT it is approving. The backend branched on `kind`
// from the start; without this branch a reschedule petition rendered as "Aprobar cancelación" —
// a button that executes a reschedule while telling the seller it cancels the folio.
describe('US-AG52 — a reschedule petition is reviewed as a reschedule', () => {
  const rescheduleReq = req({
    kind: 'reschedule',
    reason: null,
    folio_line_id: 'l1',
    to_slot_id: 's9',
    to_slot_date: '2026-06-21',
    to_slot_start_time: '09:00',
  })
  const lines = [
    {
      id: 'l1', service_id: 'svc-1', slot_id: 's1', service_name: 'Tour Isla',
      slot_date: '2026-06-14', slot_start_time: '09:00', quantity: 2,
      base_price: 150000, minimum_price: 100000, unit_price: 150000, line_total: 300000,
      extras: [],
    },
  ]

  it('says reagendar, shows from → to, and never offers to cancel', () => {
    renderWork(folio({ folio_requests: [rescheduleReq], lines } as Partial<FolioDetail>))

    expect(screen.getByText('El cliente pidió reagendar')).toBeInTheDocument()
    // The seller decides on "from → to", not on a slot UUID.
    expect(screen.getByText(/Tour Isla · 2026-06-14 09:00/)).toBeInTheDocument()
    expect(screen.getByText(/2026-06-21 09:00/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aprobar reagenda' })).toBeInTheDocument()
    // The button that lied: approving a reschedule must never read as a cancellation.
    expect(screen.queryByText('Aprobar cancelación')).toBeNull()
    expect(screen.queryByText('El cliente pidió cancelar')).toBeNull()
  })

  it('an approved reschedule renders nothing here — its `rescheduled` event tells the story', () => {
    const { container } = renderWork(
      folio({
        folio_requests: [
          req({
            id: 'r3', kind: 'reschedule', status: 'approved', reason: null,
            to_slot_date: '2026-06-21', to_slot_start_time: '09:00',
          }),
        ],
      }),
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('a request without kind is a cancellation — the pre-rename rows keep their meaning', () => {
    renderWork(folio({ folio_requests: [req({})] }))
    expect(screen.getByText('El cliente pidió cancelar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aprobar cancelación' })).toBeInTheDocument()
  })

  it('the ladder: an open petition parks the verification — one pending action at a time', () => {
    renderWork(folio({ payment_verification: 'pending', folio_requests: [req({})] }))
    expect(screen.getByText('El cliente pidió cancelar')).toBeInTheDocument()
    // The unverified transfer waits its turn; the header chip still says it exists.
    expect(screen.queryByText('Pago por verificar')).toBeNull()
  })
})

// D21 — the whole D12 ladder lives in this ONE component: solicitud → verificación → reembolso →
// entrega, exactly one rung rendered. The exclusion used to be three booleans threaded through
// three blocks of the page — these tests are the regression net for "two rungs at once".
describe('D21 — the unified pending-action card renders exactly one rung', () => {
  const refundable = (): Partial<FolioDetail> => ({
    status: 'cancelled',
    refund_status: 'pending',
    refund_amount: 180000,
    amount_paid: 300000,
  })

  it('rung 3: an open refund renders as a WARNING with the confirm button, and reports the amount', async () => {
    const onConfirmRefund = vi.fn()
    renderWork(folio(refundable()), onConfirmRefund)

    expect(screen.getByText(/Reembolso pendiente de \$1,800\.00/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar reembolso' }))
    expect(onConfirmRefund).toHaveBeenCalledOnce()
  })

  it('rung 3 parks: an open petition outranks the refund — cash stays in the drawer', () => {
    renderWork(folio({ ...refundable(), folio_requests: [req({})] }))

    expect(screen.getByText('El cliente pidió cancelar')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirmar reembolso' })).toBeNull()
  })

  it('rung 4: a paid folio with a portal offers delivery — the card\'s resting face', () => {
    renderWork(folio({ portal_link: 'https://portal/x', agent: { name: 'Leo' } } as Partial<FolioDetail>))
    expect(screen.getByText('Entregar boletos')).toBeInTheDocument()
  })

  it('rung 4 parks behind every blocking rung — unverified money never delivers tickets', () => {
    renderWork(
      folio({
        payment_verification: 'pending',
        portal_link: 'https://portal/x',
        agent: { name: 'Leo' },
      } as Partial<FolioDetail>),
    )
    expect(screen.getByText('Pago por verificar')).toBeInTheDocument()
    expect(screen.queryByText('Entregar boletos')).toBeNull()
  })
})
