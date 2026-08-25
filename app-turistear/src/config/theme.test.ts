import { describe, it, expect } from 'vitest'
import { theme } from './theme'

// The keyboard focus ring is a THEME fact, and it is pinned here rather than in a screen test
// because that is the layer that failed: `--shadow-focus` was defined in the token set from the
// start, exactly one component applied it, and no test in the suite could tell — the defect only
// surfaced by tabbing through the running app (design review of /balance, Must Fix 1).
//
// jsdom cannot answer "is focus visible" (`:focus-visible` and `var()` in `box-shadow` are both
// out of reach for its computed style), so asserting the rule EXISTS is the honest version of the
// check: it cannot prove the ring renders, but it does stop the rule from being deleted or from
// drifting off the token — which is how it went missing.

const focusRule = (overrides: unknown): Record<string, unknown> | undefined => {
  const root = (overrides as { root?: Record<string, unknown> } | undefined)?.root
  return root?.['&.Mui-focusVisible'] as Record<string, unknown> | undefined
}

describe('theme — keyboard focus', () => {
  it('rings every control from MuiButtonBase', () => {
    const rule = focusRule(theme.components?.MuiButtonBase?.styleOverrides)
    expect(rule?.boxShadow).toContain('--shadow-focus')
  })

  // `disableElevation` emits its own `&.Mui-focusVisible { box-shadow: none }` at the same
  // specificity, later in the sheet — so MuiButton has to restate the ring or the primary CTA,
  // the one control a keyboard user most needs to find, silently loses it.
  it('restates the ring on MuiButton, which disableElevation would otherwise strip', () => {
    const rule = focusRule(theme.components?.MuiButton?.styleOverrides)
    expect(rule?.boxShadow).toContain('--shadow-focus')
  })

  // Text inputs are deliberately excluded: DESIGN_TOKENS.md §4 gives them a background tint
  // (`--color-focus-tint`) instead, "no outline/border/box-shadow".
  it('leaves inputs on the focus tint, not the ring', () => {
    const root = (
      theme.components?.MuiOutlinedInput?.styleOverrides as {
        root?: (arg: { theme: typeof theme }) => Record<string, Record<string, unknown>>
      }
    )?.root?.({ theme })
    const focused = root?.['&.Mui-focused']
    expect(focused?.backgroundColor).toBeDefined()
    expect(focused?.boxShadow).toBeUndefined()
  })
})
