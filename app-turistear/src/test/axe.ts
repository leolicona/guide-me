import axe from 'axe-core'
import { expect } from 'vitest'

/**
 * Assert a rendered subtree has no accessibility violations. Used INSIDE component tests rather
 * than as a separate suite (docs/TESTING.md § What we deliberately do not test) — the cost is one
 * extra assertion where the component is already mounted.
 *
 * `color-contrast` is disabled: jsdom computes no layout and does not resolve the theme's CSS
 * custom properties, so axe cannot measure contrast here and would report false violations on
 * every element. Contrast is AA-verified at the token level in
 * .design/design-system/DESIGN_TOKENS.md, which is the authority — re-deriving it from a
 * layout-less DOM would be a second, worse source.
 */
export async function expectNoA11yViolations(
  container: HTMLElement,
  /**
   * Rule ids to tolerate, each with the `BUG-0NN` that tracks the fix. Use ONLY for a defect
   * already recorded in docs/BUGS.md — never to quiet a fresh finding. Deleting an entry here is
   * how the fix gets verified.
   */
  knownIssues: Record<string, string> = {},
): Promise<void> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
  })

  const summary = results.violations
    .filter((v) => !(v.id in knownIssues))
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n) => n.html),
    }))

  expect(summary).toEqual([])
}


/**
 * Assert the page's heading outline is navigable: exactly one `h1`, and no level skipped on the way
 * down (coming back up is free). Screens adopt it in one line.
 *
 * It reads the whole document, minus `aria-hidden` subtrees — a closed BottomSheet is not part of
 * the page's outline, and its own title is an `h2` inside its dialog, which is a separate context.
 *
 * Why it exists: MUI maps `subtitle1`/`subtitle2` to `<h6>`, so every card title and every price
 * rendered at subtitle size was silently a heading. The folio detail's outline read
 * `h1 → h6 → h3 → h6` and a screen-reader user navigating by heading landed on «$2,400.00»
 * (`.design/folio-surface-parity/DESIGN_REVIEW.md`, Must Fix 2). The theme now maps those variants
 * to `<p>`; this is the guard that keeps the next accidental heading from shipping.
 */
export function expectHeadingOutline(expectedH1?: string): void {
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter((h) => !h.closest('[aria-hidden="true"]'))
    .map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? '').trim().slice(0, 40) }))

  expect(headings.filter((h) => h.level === 1)).toHaveLength(1)
  if (expectedH1 !== undefined) {
    expect(headings[0]).toMatchObject({ level: 1, text: expectedH1 })
  }

  headings.slice(1).forEach((h, i) => {
    const prev = headings[i]
    expect(
      h.level - prev.level,
      `«${prev.text}» (h${prev.level}) → «${h.text}» (h${h.level}) skips a level`,
    ).toBeLessThanOrEqual(1)
  })
}
