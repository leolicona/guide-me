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

