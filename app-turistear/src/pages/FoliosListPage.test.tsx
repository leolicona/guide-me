import { describe, it, expect, beforeAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/server'
import { aFolio, aFolioCounts } from '../test/handlers/folios'
import { renderWithProviders, screen, waitFor, userEvent } from '../test/renderWithProviders'
import FoliosListPage from './FoliosListPage'

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

// The cards' WhatsApp buttons read the session and the org to build their message.
// `onUnhandledRequest: 'error'` means an unstubbed call fails the test rather than warning.
beforeAll(() => {
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
    renderWithProviders(<FoliosListPage />)
    const pill = await screen.findByRole('button', { name: /Estado/ })

    // The pill must sit inside a container that owns the overflow. Without it the document grows
    // wider than the screen and focusing a clipped control scrolls the PAGE — heading included.
    const strip = pill.parentElement
    expect(strip).not.toBeNull()
    expect(getComputedStyle(strip!).overflowX).toBe('auto')
  })

  it('the pending-work bar owns its overflow too', async () => {
    withCounts({ verification: 2, refunds: 1, overdue: 3, undelivered: 4, cancellation_requests: 1 })
    renderWithProviders(<FoliosListPage />)

    const bar = await screen.findByRole('group', { name: 'Trabajo pendiente' })
    // Five pills is exactly the width that broke the tabs. This row is new, so it is the one most
    // likely to be built without the wrapper the rest of the app already uses.
    expect(getComputedStyle(bar.parentElement!).overflowX).toBe('auto')
  })
})

describe('US-A84 — the pending-work bar', () => {
  it('renders a pill per kind of work that exists, and none for the rest', async () => {
    withCounts({ refunds: 2, overdue: 1 })
    renderWithProviders(<FoliosListPage />)

    expect(await screen.findByRole('button', { name: /2 Reembolsos/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1 Vencido$/ })).toBeInTheDocument()
    // D5 — a quiet queue costs zero pixels. Rendering the zeroes would be the empty tabs in a new
    // costume: a permanent row whose message is "nothing to do".
    expect(screen.queryByRole('button', { name: /Por verificar/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Solicitud/ })).toBeNull()
  })

  it('disappears entirely when there is no work', async () => {
    withCounts()
    renderWithProviders(<FoliosListPage />)
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
    renderWithProviders(<FoliosListPage />)

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
    renderWithProviders(<FoliosListPage />, { initialEntries: ['/folios?tab=refunds'] })

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
    renderWithProviders(<FoliosListPage />, {
      initialEntries: ['/folios?estado=reembolso,pltano'],
    })

    // Rule 8 — matching how the server has always treated an unknown `status`. A URL that breaks on
    // a typo is a URL that breaks when a facet is renamed. The known half must still apply.
    expect(await screen.findByRole('button', { name: 'Reembolso' })).toBeInTheDocument()
  })

  it('an empty result names what it filtered by', async () => {
    withFolios([aFolio({ id: 'f1', status: 'paid' })])
    renderWithProviders(<FoliosListPage />, { initialEntries: ['/folios?estado=cancelado'] })

    // An empty list that says only "no hay folios" reads as "there are no sales" — which is how a
    // filter left on by accident becomes a bug report about missing data.
    expect(await screen.findByText(/No hay folios en Cancelado/)).toBeInTheDocument()
  })
})
