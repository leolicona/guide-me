import { describe, it, expect, beforeEach, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, waitFor, within } from '../../../test/renderWithProviders'
import userEvent from '@testing-library/user-event'
import { expectNoA11yViolations } from '../../../test/axe'
import { aFolio } from '../../../test/handlers/folios'
import { aLinkPayment, aPaymentLink } from '../../../test/handlers/devolada'
import { FolioWorkActions } from './FolioWorkActions'
import type { FolioCancellationRequest, FolioDetail } from '../types'
import type { PaymentLinkView } from '../../devolada'

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
  ({
    id: 'f1',
    status: 'paid',
    payment_verification: 'not_required',
    agent: { id: 'a1', name: 'Ana' },
    ...over,
  }) as FolioDetail

// The refund sheet lives with the page (its success path opens the receipt composer); the card
// only signals. Tests that don't press the button share this no-op.
const renderWork = (
  f: FolioDetail,
  onConfirmRefund: () => void = () => {},
  surface: 'admin' | 'seller' = 'admin',
) =>
  renderWithProviders(
    <FolioWorkActions folio={f} onConfirmRefund={onConfirmRefund} surface={surface} />,
  )

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

// US-A93 (folio-surface-parity D7) — the ladder is one component for both audiences; `surface`
// decides which rungs may be PRESSED. Three of the four are authorizations the seller does not
// hold, so for them the ladder collapses to delivery rather than becoming a second component.
describe('US-A93 — the seller may press only the rung that is theirs', () => {
  // The delivery rung's send button reads the session and the org to compose its message.
  beforeEach(() => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({ user: { id: 'u1', name: 'Ana', email: 'ana@x.com', role: 'agent' } }),
      ),
      http.get('/api/organizations/me', () =>
        HttpResponse.json({
          organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' },
        }),
      ),
    )
  })

  const ADMIN_RUNGS: [string, Partial<FolioDetail>, string][] = [
    ['a live petition', { folio_requests: [req({})] }, 'El cliente pidió cancelar'],
    ['an unverified transfer', { payment_verification: 'pending' }, 'Pago por verificar'],
    ['an owed refund', { status: 'cancelled', refund_status: 'pending' }, 'Confirmar reembolso'],
  ]

  it.each(ADMIN_RUNGS)('%s renders for the admin and NOT for the seller', (_what, over, label) => {
    const f = folio(over)
    const admin = renderWork(f)
    expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    admin.unmount()

    renderWork(f, () => {}, 'seller')
    // Nothing at all: with no rung they may press, and no delivery to offer, the card is absent.
    expect(screen.queryByText(label)).toBeNull()
  })

  it('delivery IS the seller\'s rung, and it renders for them', () => {
    renderWork(
      folio({ status: 'paid', portal_link: 'https://x/portal/abc' }),
      () => {},
      'seller',
    )
    expect(screen.getByText('Entregar boletos')).toBeInTheDocument()
  })

  it("an admin rung does not HIDE the seller's delivery — it is simply not their rung", () => {
    // A cancelled folio owing a refund AND deliverable is contrived, but it pins the ordering: the
    // seller's ladder must not go blank because a rung above theirs is true.
    renderWork(
      folio({ status: 'paid', refund_status: 'pending', portal_link: 'https://x/portal/abc' }),
      () => {},
      'seller',
    )
    expect(screen.getByText('Entregar boletos')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirmar reembolso/ })).toBeNull()
  })
})

describe('Design review, Should Fix 3 — the seller mounts no admin overlay', () => {
  // The sheets render through a PORTAL, so they are in `document.body`, never in the render
  // container — asserting on the container passes for both audiences and proves nothing. The
  // admin control below is what caught that.
  const drawers = () => document.querySelectorAll('.MuiDrawer-root')

  it("the four authorization sheets are absent from the seller's DOM", () => {
    renderWork(
      folio({ status: 'paid', portal_link: 'https://x/portal/abc' }),
      () => {},
      'seller',
    )
    // They used to render for both audiences: closed and aria-hidden, so nothing leaked, but four
    // keepMounted drawers sat on a screen with no way to open any of them — and BUG-033 is about
    // what extra keepMounted drawers do to the accessibility tree.
    expect(drawers()).toHaveLength(0)
    expect(screen.queryByText('¿Verificar el pago?')).toBeNull()
    expect(screen.queryByText('¿Aprobar la cancelación?')).toBeNull()
  })

  it('the admin still has them mounted, ready to open', () => {
    renderWork(folio({ payment_verification: 'pending' }))
    expect(drawers().length).toBeGreaterThan(0)
  })
})

// --- devolada-transfer-verification — the Devolada payments the admin decides (D15) ---------------

const link = (over: Record<string, unknown> = {}) => aPaymentLink(over) as PaymentLinkView

/** Every resolve the screen sends, in order, as the API received it. */
const captureResolves = (answer: () => Response = () => HttpResponse.json({ folio: aFolio() })) => {
  const sent: { id: string; body: unknown }[] = []
  server.use(
    http.post('/api/devolada/payments/:id/resolve', async ({ params, request }) => {
      sent.push({ id: String(params.id), body: await request.json() })
      return answer()
    }),
  )
  return sent
}

const refusal = (code: string) => () =>
  HttpResponse.json({ error: { code, message: code } }, { status: 409 })

/** Opens the rung's action, then confirms it inside its sheet. */
const decide = async (rungButton: string, sheetTitle: string, confirm = rungButton) => {
  await userEvent.click(screen.getByRole('button', { name: rungButton }))
  const sheet = await screen.findByRole('dialog', { name: sheetTitle })
  await userEvent.click(within(sheet).getByRole('button', { name: confirm }))
  return sheet
}

const noSheetOpen = () =>
  waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

beforeEach(() => {
  server.use(
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' },
      }),
    ),
  )
})

// devolada-transfer-verification US2 — anything short of a clean confirmation reaches the admin with
// the reason and the amounts: a sale exception inside today's «Pago por verificar» (FR-018), money
// to return in its own rung, with «Ya lo devolví».
describe('devolada-transfer-verification US2 — Devolada exceptions on the sale', () => {
  const unapplied = () =>
    link({
      id: 'link-late',
      state: 'closed',
      label: 'unapplied',
      payment: aLinkPayment({
        id: 'dpay-late',
        status: 'unapplied',
        received: 150_000,
        match: 'exact',
        receipt_number: 'DV-0042',
      }),
    })

  it('a sale exception shows its label, its receipt and its amounts inside «Pago por verificar»', async () => {
    const { container } = renderWork(
      folio({
        payment_verification: 'pending',
        payment_links: [
          link({
            label: 'partial',
            payment: aLinkPayment({
              status: 'partial',
              received: 100_000,
              match: 'short',
              receipt_number: 'DV-0001',
            }),
          }),
        ],
      }),
    )

    expect(screen.getByRole('heading', { name: 'Pago por verificar' })).toBeInTheDocument()
    expect(screen.getByText('Pago incompleto')).toBeInTheDocument()
    expect(screen.getByText('Comprobante Devolada DV-0001')).toBeInTheDocument()
    expect(screen.getByLabelText('Solicitado: $1,500.00')).toBeInTheDocument()
    expect(screen.getByLabelText('Declarado: $1,500.00')).toBeInTheDocument()
    expect(screen.getByLabelText('Recibido: $1,000.00')).toBeInTheDocument()
    // FR-018 — today's two verbs, unchanged; nothing of the resolve endpoint's.
    expect(screen.getByRole('button', { name: 'Verificar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rechazar pago' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Descartar' })).toBeNull()
    await expectNoA11yViolations(container)
  })

  it('«Ya lo devolví» resolves the payment as `returned`', async () => {
    const sent = captureResolves()
    const { container } = renderWork(
      folio({ status: 'cancelled', devolada_attention: true, payment_links: [unapplied()] }),
    )

    expect(screen.getByRole('heading', { name: 'Pago por transferencia' })).toBeInTheDocument()
    expect(screen.getByText('Dinero por devolver')).toBeInTheDocument()
    expect(screen.getByText('Comprobante Devolada DV-0042')).toBeInTheDocument()
    expect(screen.getByLabelText('Recibido: $1,500.00')).toBeInTheDocument()
    await expectNoA11yViolations(container)

    const sheet = await decide('Ya lo devolví', '¿Ya devolviste el dinero?')
    expect(sheet).toHaveTextContent('No cambia ningún monto de la venta.')
    await waitFor(() => expect(sent).toEqual([{ id: 'dpay-late', body: { action: 'returned' } }]))
    await noSheetOpen()
  })

  it('the Devolada rung waits behind «Pago por verificar», one rung at a time', () => {
    renderWork(
      folio({ payment_verification: 'pending', devolada_attention: true, payment_links: [unapplied()] }),
    )

    expect(screen.getByText('Pago por verificar')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ya lo devolví' })).toBeNull()
  })

  it('and goes before the refund: money that arrived is answered for before cash leaves the drawer', () => {
    renderWork(
      folio({
        status: 'cancelled',
        refund_status: 'pending',
        refund_amount: 150_000,
        payment_links: [unapplied()],
      }),
    )

    expect(screen.getByRole('button', { name: 'Ya lo devolví' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirmar reembolso' })).toBeNull()
  })

  it('a decision taken already is refused inside the sheet, which then only closes', async () => {
    const sent = captureResolves(refusal('DEVOLADA_PAYMENT_NOT_RESOLVABLE'))
    renderWork(folio({ status: 'cancelled', payment_links: [unapplied()] }))

    const sheet = await decide('Ya lo devolví', '¿Ya devolviste el dinero?')

    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'Este pago ya no admite esa acción: ya se resolvió o la venta cambió.',
    )
    expect(sent).toHaveLength(1)
    expect(within(sheet).queryByRole('button', { name: 'Ya lo devolví' })).toBeNull()
    await expectNoA11yViolations(sheet)
    // The footer's «Cerrar» (the sheet's own close glyph is named the same, and does the same).
    const [, footerClose] = within(sheet).getAllByRole('button', { name: 'Cerrar' })
    await userEvent.click(footerClose)
    await noSheetOpen()
  })

  it('the seller is offered no decision', () => {
    const { container } = renderWork(
      folio({ status: 'cancelled', payment_links: [unapplied()] }),
      () => {},
      'seller',
    )

    expect(container).toBeEmptyDOMElement()
    expect(document.querySelectorAll('.MuiDrawer-root')).toHaveLength(0)
  })
})

// devolada-transfer-verification US3 — a settlement records nothing until it is proven (D8), so its
// exceptions have no pending row for «Verificar» to flip: the admin accepts or dismisses the payment
// itself. One verb per action: «Verificar» (accept), «Descartar» (dismiss) — research D15.
describe('devolada-transfer-verification US3 — an apartado’s settlement decided by the admin', () => {
  const apartado = (settlement: PaymentLinkView, over: Partial<FolioDetail> = {}) =>
    folio({
      status: 'booking',
      payment_verification: 'verified',
      total: 300_000,
      amount_paid: 150_000,
      pending_balance: 150_000,
      payment_links: [settlement],
      ...over,
    })

  const exception = () =>
    link({
      id: 'link-settle',
      kind: 'settlement',
      state: 'closed',
      label: 'partial',
      payment: aLinkPayment({
        id: 'dpay-settle',
        status: 'partial',
        received: 100_000,
        match: 'short',
        receipt_number: 'DV-0077',
      }),
    })

  // D21 — an enlace no key can read any more, its payment last seen in flight.
  const unreadable = () =>
    link({
      id: 'link-lost',
      kind: 'settlement',
      state: 'failed',
      url: null,
      label: 'link_failed',
      payment: aLinkPayment({ id: 'dpay-lost' }),
    })

  it('an exception: its label and amounts, «Verificar» and «Descartar»', async () => {
    const { container } = renderWork(apartado(exception(), { devolada_attention: true }))

    expect(screen.getByRole('heading', { name: 'Liquidación por transferencia' })).toBeInTheDocument()
    expect(screen.getByText('Pago incompleto')).toBeInTheDocument()
    expect(screen.getByText('Comprobante Devolada DV-0077')).toBeInTheDocument()
    expect(screen.getByLabelText('Recibido: $1,000.00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verificar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Descartar' })).toBeInTheDocument()
    // Not today's sale-level verbs: there is no pending row, and Rechazar would cancel the sale.
    expect(screen.queryByRole('button', { name: 'Rechazar pago' })).toBeNull()
    await expectNoA11yViolations(container)
  })

  it('«Verificar» resolves the exception as `accept`', async () => {
    const sent = captureResolves()
    renderWork(apartado(exception(), { devolada_attention: true }))

    const sheet = await decide('Verificar', '¿Verificar la liquidación?')
    expect(sheet).toHaveTextContent('Se registra la liquidación como verificada por ti')
    await waitFor(() => expect(sent).toEqual([{ id: 'dpay-settle', body: { action: 'accept' } }]))
    await noSheetOpen()
  })

  it('«Descartar» resolves it as `dismiss`, and says the apartado stays and nothing is cancelled', async () => {
    const sent = captureResolves()
    renderWork(apartado(exception(), { devolada_attention: true }))

    const sheet = await decide('Descartar', '¿Descartar el pago?')
    expect(sheet).toHaveTextContent('El apartado sigue vigente y no se cancela nada.')
    await expectNoA11yViolations(sheet)
    await waitFor(() => expect(sent).toEqual([{ id: 'dpay-settle', body: { action: 'dismiss' } }]))
    await noSheetOpen()
  })

  it('an enlace no key can read: «Verificar» accepts and «Descartar» dismisses its payment (D21)', async () => {
    const sent = captureResolves()
    const { container, unmount } = renderWork(apartado(unreadable(), { devolada_attention: true }))

    expect(screen.getByText('Sin enlace de pago — verificar a mano')).toBeInTheDocument()
    await expectNoA11yViolations(container)
    await decide('Verificar', '¿Verificar la liquidación?')
    await waitFor(() => expect(sent).toEqual([{ id: 'dpay-lost', body: { action: 'accept' } }]))
    unmount()

    renderWork(apartado(unreadable(), { devolada_attention: true }))
    await decide('Descartar', '¿Descartar el pago?')
    await waitFor(() => expect(sent[1]).toEqual({ id: 'dpay-lost', body: { action: 'dismiss' } }))
  })

  it('a settlement Devolada is still verifying gets «Verificar» alone, in Por verificar or not (D15)', async () => {
    const sent = captureResolves()
    const verifying = link({
      id: 'link-wait',
      kind: 'settlement',
      label: 'validating',
      payment: aLinkPayment({ id: 'dpay-wait' }),
    })
    // Nothing for the admin to do — the sale is not in Por verificar — and still their option.
    const { container } = renderWork(apartado(verifying, { devolada_attention: false }))

    expect(screen.getByText('Verificando pago')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verificar' })).toBeInTheDocument()
    // Closing its enlace would turn the money unapplied (D13): no «Descartar».
    expect(screen.queryByRole('button', { name: 'Descartar' })).toBeNull()
    await expectNoA11yViolations(container)

    await decide('Verificar', '¿Verificar la liquidación?')
    await waitFor(() => expect(sent).toEqual([{ id: 'dpay-wait', body: { action: 'accept' } }]))
  })

  it('a tracking key to ask for on the settlement: «Verificar» alone too', () => {
    renderWork(
      apartado(
        link({
          kind: 'settlement',
          label: 'needs_tracking_key',
          payment: aLinkPayment({ awaiting: 'payer_tracking_key' }),
        }),
        { devolada_attention: true },
      ),
    )

    expect(screen.getByText('Pide al cliente su clave de rastreo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verificar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Descartar' })).toBeNull()
  })

  it('on a sale that no longer owes it, the exception is only discarded', () => {
    renderWork(apartado(exception(), { status: 'cancelled', devolada_attention: true }))

    expect(screen.getByRole('button', { name: 'Descartar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verificar' })).toBeNull()
  })

  it('a sale cancelled meanwhile is refused inside the sheet', async () => {
    captureResolves(refusal('FOLIO_CANCELLED'))
    renderWork(apartado(exception(), { devolada_attention: true }))

    const sheet = await decide('Verificar', '¿Verificar la liquidación?')

    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'La venta está cancelada: la liquidación ya no se puede verificar.',
    )
    expect(within(sheet).queryByRole('button', { name: 'Verificar' })).toBeNull()
    expect(within(sheet).getAllByRole('button', { name: 'Cerrar' })).toHaveLength(2)
  })

  it('any other failure can be tried again', async () => {
    captureResolves(() => HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, { status: 500 }))
    renderWork(apartado(exception(), { devolada_attention: true }))

    const sheet = await decide('Descartar', '¿Descartar el pago?')

    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'No se pudo registrar. Inténtalo de nuevo.',
    )
    expect(within(sheet).getByRole('button', { name: 'Descartar' })).toBeEnabled()
  })
})
