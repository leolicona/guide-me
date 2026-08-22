import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { aFolio, aFolioCounts } from '../../../test/handlers/folios'
import { renderWithProviders, screen, waitFor, userEvent } from '../../../test/renderWithProviders'
import { FolioListScreen } from './FolioListScreen'

// US-A84 — the unified folio list. This file also inherits BUG-023's guard.
//
// BUG-023 was one root cause with two faces: a control row wider than the viewport with nothing
// owning the overflow. US-A84 deletes the tabs, so the two tab assertions are gone with them — but
// the defect is not tab-specific, and this screen now has TWO control rows (the pending-work bar
// and the Estado strip). Both must still be wrapped in `FilterStrip`, which is what the surviving
// assertion checks.
//
// What a jsdom test CAN and CANNOT prove here is stated rather than implied. jsdom has no layout
// engine — every box is 0×0 — so the overflow itself is unprovable at this tier and was measured in
// a real browser (numbers in docs/BUGS.md). What IS provable, and is the real regression risk, is
// that the containing element still owns the overflow: dropping `FilterStrip` is a small edit that
// silently restores the bug.

// The cards' WhatsApp buttons read the session and the org to build their message, and the date
// presets read the org's ZONE. Registered in `beforeEach`, not `beforeAll`: MSW resets handlers
// after every test, so a `beforeAll` registration survives exactly one of them — which is how the
// first tests in this file passed while the later ones failed on an unhandled `/organizations/me`.
beforeEach(() => {
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({ user: { id: 'u1', name: 'Ana', email: 'ana@x.com', role: 'admin' } }),
    ),
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' },
      }),
    ),
  )
})

const withCounts = (over: Record<string, number> = {}) =>
  server.use(http.get('/api/folios/counts', () => HttpResponse.json(aFolioCounts(over))))

const withFolios = (folios: unknown[]) =>
  server.use(
    http.get('/api/folios', () => HttpResponse.json({ folios, window_days: 30 })),
  )

describe('BUG-023 — the control rows survive a narrow viewport', () => {
  it('the filter row scrolls inside itself instead of widening the document', async () => {
    renderWithProviders(<FolioListScreen surface="admin" />)
    const pill = await screen.findByRole('button', { name: /Estado/ })

    // The pill must sit inside a container that owns the overflow. Without it the document grows
    // wider than the screen and focusing a clipped control scrolls the PAGE — heading included.
    const strip = pill.parentElement
    expect(strip).not.toBeNull()
    expect(getComputedStyle(strip!).overflowX).toBe('auto')
  })

  it('the pending-work bar owns its overflow too', async () => {
    withCounts({ verification: 2, refunds: 1, overdue: 3, undelivered: 4, folio_requests: 1 })
    renderWithProviders(<FolioListScreen surface="admin" />)

    const bar = await screen.findByRole('group', { name: 'Trabajo pendiente' })
    // Five pills is exactly the width that broke the tabs. This row is new, so it is the one most
    // likely to be built without the wrapper the rest of the app already uses.
    expect(getComputedStyle(bar.parentElement!).overflowX).toBe('auto')
  })
})

describe('US-A84 — the pending-work bar', () => {
  it('renders a pill per kind of work that exists, and none for the rest', async () => {
    withCounts({ refunds: 2, overdue: 1 })
    renderWithProviders(<FolioListScreen surface="admin" />)

    expect(await screen.findByRole('button', { name: /2 Reembolsos/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1 Vencido$/ })).toBeInTheDocument()
    // D5 — a quiet queue costs zero pixels. Rendering the zeroes would be the empty tabs in a new
    // costume: a permanent row whose message is "nothing to do".
    expect(screen.queryByRole('button', { name: /Por verificar/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Solicitud/ })).toBeNull()
  })

  it('disappears entirely when there is no work', async () => {
    withCounts()
    renderWithProviders(<FolioListScreen surface="admin" />)
    await screen.findByRole('button', { name: /Estado/ })

    expect(screen.queryByRole('group', { name: 'Trabajo pendiente' })).toBeNull()
  })

  it('applies a facet in place instead of navigating away', async () => {
    withCounts({ refunds: 1 })
    withFolios([
      aFolio({ id: 'owed', status: 'cancelled', refund_status: 'pending', refund_amount: 50_000 }),
      aFolio({ id: 'settled', status: 'paid' }),
    ])
    const user = userEvent.setup()
    renderWithProviders(<FolioListScreen surface="admin" />)

    await user.click(await screen.findByRole('button', { name: /1 Reembolso/ }))

    // D6 — the pill is a FILTER, not a link: the list narrows and the pill reads active, so the
    // admin is never looking at a filtered list without knowing it. That was exactly what arriving
    // at a tab did.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /1 Reembolso/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    // The Estado pill names the facet too — the state is visible in both places, never implicit.
    expect(screen.getByRole('button', { name: 'Reembolso' })).toBeInTheDocument()
  })
})

describe('US-A84 — the URL is the state', () => {
  it('S-12 — an old ?tab= link lands on its facet', async () => {
    withCounts({ refunds: 1 })
    withFolios([
      aFolio({ id: 'owed', status: 'cancelled', refund_status: 'pending', refund_amount: 50_000 }),
      aFolio({ id: 'settled', status: 'paid' }),
    ])
    renderWithProviders(<FolioListScreen surface="admin" />, { initialEntries: ['/folios?tab=refunds'] })

    // D17 — there are live links in Hoy and, plausibly, bookmarks. Losing them would make the two
    // money queues unreachable a second time, which is what BUG-023 was about. Asserted through the
    // CONSEQUENCE (the facet is on) rather than the URL string, so it still holds if the encoding
    // ever changes — and it fails outright if the redirect is dropped.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reembolso' })).toBeInTheDocument(),
    )
  })

  it('S-14 — an unknown facet value is ignored, not fatal', async () => {
    withFolios([
      aFolio({ id: 'owed', status: 'cancelled', refund_status: 'pending', refund_amount: 50_000 }),
    ])
    renderWithProviders(<FolioListScreen surface="admin" />, {
      initialEntries: ['/folios?estado=reembolso,pltano'],
    })

    // Rule 8 — matching how the server has always treated an unknown `status`. A URL that breaks on
    // a typo is a URL that breaks when a facet is renamed. The known half must still apply.
    expect(await screen.findByRole('button', { name: 'Reembolso' })).toBeInTheDocument()
  })

  it('an empty result names what it filtered by', async () => {
    withFolios([aFolio({ id: 'f1', status: 'paid' })])
    renderWithProviders(<FolioListScreen surface="admin" />, { initialEntries: ['/folios?estado=cancelado'] })

    // An empty list that says only "no hay folios" reads as "there are no sales" — which is how a
    // filter left on by accident becomes a bug report about missing data.
    //
    // US-A83 D15 CHANGED the wording: with three filter axes the message names all of them, so
    // "No hay folios en X" became "Sin resultados para X · Y · Z". The assertion moved with it
    // rather than being deleted — what it guards is that the FACET is named, not the phrasing.
    expect(await screen.findByText(/Sin resultados para Cancelado/)).toBeInTheDocument()
  })
})

describe('US-A83 — finding one sale', () => {
  const twoFolios = () =>
    withFolios([
      aFolio({ id: 'isla', customer_name: 'María Fernández', lines: [{ service_name: 'Tour Isla Mujeres', quantity: 2 }] }),
      aFolio({ id: 'otro', customer_name: 'Pedro', lines: [{ service_name: 'Chichén Itzá', quantity: 1 }] }),
    ])

  it('filters locally as you type, over the service name', async () => {
    twoFolios()
    const user = userEvent.setup()
    renderWithProviders(<FolioListScreen surface="admin" />)
    await screen.findByText(/Tour Isla Mujeres/)

    await user.type(screen.getByRole('textbox', { name: 'Buscar folios' }), 'isla')

    await waitFor(() => expect(screen.queryByText(/Chichén/)).toBeNull())
    expect(screen.getByText(/Tour Isla Mujeres/)).toBeInTheDocument()
  })

  it('S-6 — when nothing matches locally, the server is asked and the screen SAYS so', async () => {
    let asked: string | null = null
    twoFolios()
    server.use(
      http.get('/api/folios', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q')
        if (!q) {
          return HttpResponse.json({
            folios: [aFolio({ id: 'isla', customer_name: 'María', lines: [] })],
            window_days: 30,
          })
        }
        asked = q
        return HttpResponse.json({
          folios: [aFolio({ id: 'viejo', customer_name: 'Leo Licona', lines: [] })],
          window_days: null,
          truncated: false,
        })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<FolioListScreen surface="admin" />)
    await screen.findByRole('textbox', { name: 'Buscar folios' })

    await user.type(screen.getByRole('textbox', { name: 'Buscar folios' }), 'leo')

    // The window bounds the DEFAULT read; it must not bound what is findable (D4). And the label is
    // what keeps the window honest once it can be crossed (D5) — otherwise the same screen shows
    // "everything recent" and "everything ever" with no way to tell which.
    await waitFor(() => expect(screen.getByText(/Leo Licona/)).toBeInTheDocument(), { timeout: 3000 })
    expect(asked).toBe('leo')
    expect(screen.getByText(/Resultados de todo el historial/)).toBeInTheDocument()
  })

  it('S-7 — a capped fallback says it capped', async () => {
    twoFolios()
    server.use(
      http.get('/api/folios', ({ request }) =>
        new URL(request.url).searchParams.get('q')
          ? HttpResponse.json({
              folios: [aFolio({ id: 'viejo', customer_name: 'Leo', lines: [] })],
              window_days: null,
              truncated: true,
            })
          : HttpResponse.json({ folios: [aFolio({ id: 'a', customer_name: 'Ana', lines: [] })], window_days: 30 }),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<FolioListScreen surface="admin" />)
    await screen.findByRole('textbox', { name: 'Buscar folios' })

    await user.type(screen.getByRole('textbox', { name: 'Buscar folios' }), 'leo')

    await waitFor(() => expect(screen.getByText(/50 más recientes/)).toBeInTheDocument(), {
      timeout: 3000,
    })
  })

  it('S-5 — one character asks the server nothing and hides nothing', async () => {
    let queries = 0
    twoFolios()
    server.use(
      http.get('/api/folios', ({ request }) => {
        if (new URL(request.url).searchParams.get('q')) queries += 1
        return HttpResponse.json({
          folios: [aFolio({ id: 'isla', customer_name: 'María', lines: [] })],
          window_days: 30,
        })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<FolioListScreen surface="admin" />)
    await screen.findByRole('textbox', { name: 'Buscar folios' })

    await user.type(screen.getByRole('textbox', { name: 'Buscar folios' }), 'a')

    // Below the floor the list is untouched: the first keystroke must not empty the screen.
    await waitFor(() => expect(screen.getByText(/María/)).toBeInTheDocument())
    expect(queries).toBe(0)
  })

  it('S-11 — the empty state names the QUERY as well as the facet', async () => {
    withFolios([aFolio({ id: 'a', status: 'paid', customer_name: 'Ana', lines: [] })])
    server.use(
      http.get('/api/folios', ({ request }) =>
        new URL(request.url).searchParams.get('q')
          ? HttpResponse.json({ folios: [], window_days: null, truncated: false })
          : HttpResponse.json({
              folios: [aFolio({ id: 'a', status: 'paid', customer_name: 'Ana', lines: [] })],
              window_days: 30,
            }),
      ),
    )
    renderWithProviders(<FolioListScreen surface="admin" />, { initialEntries: ['/folios?q=zzz&estado=cancelado'] })

    // Naming one filter and hiding the other is how a user removes the wrong one (D15). Asserted
    // as ONE message rather than two matches, because "Cancelado" also names the Estado pill.
    await waitFor(
      () => expect(screen.getByText(/Sin resultados para «zzz» · Cancelado/)).toBeInTheDocument(),
      { timeout: 3000 },
    )
  })

  it('S-10 — a pending-work pill clears the query and the range', async () => {
    withCounts({ refunds: 1 })
    withFolios([
      aFolio({ id: 'owed', status: 'cancelled', refund_status: 'pending', refund_amount: 5000, lines: [] }),
    ])
    const user = userEvent.setup()
    renderWithProviders(<FolioListScreen surface="admin" />, {
      initialEntries: ['/folios?q=leo&desde=2026-01-01&hasta=2026-01-31'],
    })

    await user.click(await screen.findByRole('button', { name: /1 Reembolso/ }))

    // D13 — the banner's one promise is that its count equals what its pill shows (US-A84 S-4).
    // Intersecting it with a leftover query breaks that silently: "1 Reembolso" leading to zero rows.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Buscar folios' })).toHaveValue(''),
    )
    expect(screen.getByRole('button', { name: 'Reembolso' })).toBeInTheDocument()
  })

  it('the date presets render once the ORG’s clock is known, and read its zone', async () => {
    twoFolios()
    renderWithProviders(<FolioListScreen surface="admin" />)

    // `useNowSeconds` resolves in an EFFECT, and computing a preset against an empty day threw
    // `RangeError: Invalid time value` and took the whole page down on first paint during this
    // build. This asserts the OUTCOME, not the pre-effect frame: RTL wraps `render` in `act()`,
    // which flushes effects before it returns, so the frame where `today` is null is not observable
    // here. The guard is proven by the crash it fixed, not by this line.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hoy' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Ayer' })).toBeInTheDocument()
  })
})

describe('US-A83 — the screen states ONE scope at a time', () => {
  it('the window footer disappears once the fallback left the window', async () => {
    withFolios([aFolio({ id: 'a', customer_name: 'Ana', lines: [] })])
    server.use(
      http.get('/api/folios', ({ request }) =>
        new URL(request.url).searchParams.get('q')
          ? HttpResponse.json({
              folios: [aFolio({ id: 'viejo', customer_name: 'Leo', lines: [] })],
              window_days: null,
              truncated: false,
            })
          : HttpResponse.json({
              folios: [aFolio({ id: 'a', customer_name: 'Ana', lines: [] })],
              window_days: 30,
            }),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<FolioListScreen surface="admin" />)
    await screen.findByText(/Últimos 30 días/)

    await user.type(screen.getByRole('textbox', { name: 'Buscar folios' }), 'leo')

    // The footer used to read `data.window_days` — the BASE read — so it kept claiming
    // "últimos 30 días" directly under a banner saying the opposite. Two statements about scope,
    // contradicting each other on one screen. Only found by rendering it.
    await waitFor(() => expect(screen.getByText(/Resultados de todo el historial/)).toBeInTheDocument(), {
      timeout: 3000,
    })
    expect(screen.queryByText(/más todo lo que tiene trabajo pendiente/)).toBeNull()
  })

  it('the window footer disappears while a date range is applied', async () => {
    withFolios([aFolio({ id: 'a', customer_name: 'Ana', lines: [] })])
    renderWithProviders(<FolioListScreen surface="admin" />, {
      initialEntries: ['/folios?desde=2026-01-01&hasta=2026-01-31'],
    })

    await screen.findByText(/Ana/)
    expect(screen.queryByText(/Últimos 30 días/)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// US-AG58 (folio-surface-parity D10) — what must be TRUE OF BOTH surfaces, asserted against both.
//
// The invariant belongs in the file that would break it. Everything above this line is the admin's
// list, because the window, the fallback and the pending-work bar are the admin's; everything below
// is the promise that the seller's screen is the same screen minus the verbs they may not press.
// ---------------------------------------------------------------------------

/** The seller's endpoint returns the SAME row shape (`serializeFolioListRow`), with `truncated`. */
const withMyFolios = (folios: unknown[], truncated = false) =>
  server.use(http.get('/api/pos/folios', () => HttpResponse.json({ folios, truncated })))

const SURFACES = [
  { surface: 'admin' as const, route: '/folios', seed: withFolios },
  { surface: 'seller' as const, route: '/history', seed: (f: unknown[]) => withMyFolios(f) },
]

describe.each(SURFACES)('US-AG58 — $surface: the list behaves the same', ({ surface, route, seed }) => {
  it('the filter lives in the URL, so it survives the trip to a detail and back', async () => {
    seed([aFolio({ id: 'f1', status: 'paid' })])
    renderWithProviders(<FolioListScreen surface={surface} />, {
      initialEntries: [`${route}?estado=cancelado`],
    })
    // The seller's old screen kept this in `useState`: opening a sale and pressing back reset it,
    // silently, every time.
    expect(await screen.findByRole('button', { name: 'Cancelado' })).toBeInTheDocument()
  })

  it('an empty result NAMES the filter that emptied it', async () => {
    seed([aFolio({ id: 'f1', status: 'paid' })])
    renderWithProviders(<FolioListScreen surface={surface} />, {
      initialEntries: [`${route}?estado=cancelado`],
    })
    // «Aún no tienes ventas registradas» under an active filter is simply untrue, and it is what
    // the seller's screen said. That sentence is now reserved for a seller with no sales at all.
    expect(await screen.findByText(/Sin resultados para Cancelado/)).toBeInTheDocument()
  })

  it('search filters locally, over the service name', async () => {
    seed([
      aFolio({ id: 'isla', customer_name: 'María Fernández', lines: [{ service_name: 'Tour Isla Mujeres', quantity: 2 }] }),
      aFolio({ id: 'otro', customer_name: 'Pedro', lines: [{ service_name: 'Chichén Itzá', quantity: 1 }] }),
    ])
    const user = userEvent.setup()
    renderWithProviders(<FolioListScreen surface={surface} />, { initialEntries: [route] })
    await screen.findByText(/Tour Isla Mujeres/)

    await user.type(screen.getByRole('textbox', { name: 'Buscar folios' }), 'isla')
    await waitFor(() => expect(screen.queryByText(/Chichén Itzá/)).not.toBeInTheDocument())
    expect(screen.getByText(/Tour Isla Mujeres/)).toBeInTheDocument()
  })

  it('facets compose instead of excluding', async () => {
    // The question the seller's exclusive toggle could not ask: cancelled AND still owing a refund.
    seed([
      aFolio({ id: 'owed', status: 'cancelled', refund_status: 'pending', refund_amount: 50_000, customer_name: 'Debe' }),
      aFolio({ id: 'plain', status: 'cancelled', customer_name: 'Sin deuda' }),
    ])
    renderWithProviders(<FolioListScreen surface={surface} />, {
      initialEntries: [`${route}?estado=cancelado,reembolso`],
    })
    expect(await screen.findByText(/Debe/)).toBeInTheDocument()
    expect(screen.queryByText(/Sin deuda/)).not.toBeInTheDocument()
  })
})

describe('US-AG58 — what the seller does NOT get', () => {
  it('no pending-work bar (US-AG50 stands)', async () => {
    withCounts({ verification: 2, refunds: 1, overdue: 3, undelivered: 4, folio_requests: 1 })
    withMyFolios([aFolio({ id: 'f1' })])
    renderWithProviders(<FolioListScreen surface="seller" />, { initialEntries: ['/history'] })

    await screen.findByText(/Cliente Uno/)
    // The seller can act on exactly one kind of pending work, already carried by the facet sheet
    // and by the card's single button. A bar with one pill is not a bar.
    expect(screen.queryByRole('group', { name: 'Trabajo pendiente' })).not.toBeInTheDocument()
  })

  it('no admin verb on a card that would earn one on the admin list', async () => {
    // A transfer awaiting verification: the admin's card offers «Verificar y enviar».
    const awaiting = aFolio({
      id: 'f1',
      payment_verification: 'pending',
      payment_reference: 'REF-9',
      deliverable: false,
    })
    withMyFolios([awaiting])
    renderWithProviders(<FolioListScreen surface="seller" />, { initialEntries: ['/history'] })

    await screen.findByText(/Cliente Uno/)
    expect(screen.queryByRole('button', { name: /Verificar/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirmar reembolso/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Revisar solicitud/ })).not.toBeInTheDocument()
  })

  it('D5 — a capped list says so; an uncapped one stays quiet', async () => {
    withMyFolios([aFolio({ id: 'f1' })], true)
    renderWithProviders(<FolioListScreen surface="seller" />, { initialEntries: ['/history'] })
    expect(await screen.findByText(/500 ventas más recientes/)).toBeInTheDocument()
  })

  it('D4 — no window footer: the seller\'s list has no window to state', async () => {
    withMyFolios([aFolio({ id: 'f1' })])
    renderWithProviders(<FolioListScreen surface="seller" />, { initialEntries: ['/history'] })
    await screen.findByText(/Cliente Uno/)
    expect(screen.queryByText(/Últimos \d+ días/)).not.toBeInTheDocument()
  })
})
