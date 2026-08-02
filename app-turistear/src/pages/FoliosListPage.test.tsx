import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../test/renderWithProviders'
import FoliosListPage from './FoliosListPage'

// BUG-023 — two of the five tabs were unreachable on a phone, and the filter row dragged the whole
// page sideways. Both are one root cause: a control row wider than the viewport with no overflow
// handling.
//
// What a jsdom test CAN and CANNOT prove here matters, so it is stated rather than implied. jsdom
// has no layout engine — every box is 0×0 — so the overflow itself is unprovable at this tier and
// was measured in a real browser instead (the numbers live in docs/BUGS.md). What IS provable, and
// is the actual regression risk, is that the props which make the rows scrollable are still there:
// deleting `variant="scrollable"` is a one-character edit that silently restores the bug.

describe('BUG-023 — the control rows survive a narrow viewport', () => {
  // NOT a guard for BUG-023 — this passes with the bug present, because the tabs were always in
  // the DOM; they were merely clipped out of reach. It guards a different regression: that all
  // five still EXIST, so a later refactor cannot quietly drop a queue.
  it('all five tabs exist (presence, not reachability)', async () => {
    renderWithProviders(<FoliosListPage />)

    // Reembolsos and Vencidos are the money queues (US-A78/A79) that shipped invisible on mobile.
    for (const name of ['Folios', 'Por verificar', 'Solicitudes', 'Reembolsos', 'Vencidos']) {
      expect(await screen.findByRole('tab', { name: new RegExp(name) })).toBeInTheDocument()
    }
  })

  it('the tab row is scrollable, with the buttons kept on mobile', async () => {
    const { container } = renderWithProviders(<FoliosListPage />)
    await screen.findByRole('tab', { name: /Vencidos/ })

    // MUI stamps these classes from `variant="scrollable"` and `allowScrollButtonsMobile`.
    // allowScrollButtonsMobile is the load-bearing half: MUI hides the arrows on mobile by
    // default, which is exactly the width where they are the only way to reach a clipped tab.
    expect(container.querySelector('.MuiTabs-scroller.MuiTabs-scrollableX')).not.toBeNull()
    expect(container.querySelector('.MuiTabs-scrollButtonsHideMobile')).toBeNull()
  })

  it('the status filter row scrolls inside itself instead of widening the document', async () => {
    const { container } = renderWithProviders(<FoliosListPage />)
    const group = await screen.findByRole('group')

    // The group must sit inside a container that owns the overflow. Without it the document grows
    // wider than the screen and focusing a clipped button scrolls the PAGE — heading included.
    const strip = group.parentElement
    expect(strip).not.toBeNull()
    expect(container.contains(strip!)).toBe(true)
    expect(getComputedStyle(strip!).overflowX).toBe('auto')
  })
})
