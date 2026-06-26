# Design Tokens: GuideMe — "Elegant Field Minimalism"

> Canonical token reference for the whole-product design system. Derived from
> `.design/design-system/DESIGN_BRIEF.md`. **Fresh synthesis** — this *replaces* the indigo
> "Luminous SaaS" system in `docs/DESING.md` + `app-guideme/src/config/theme.ts`. Phase 6 ports
> these values into `theme.ts` (MUI `createTheme`) and a CSS-variable layer; this file is the
> source of truth. Stack is **MUI v6 CSS-in-JS** (`cssVariables: true`).
>
> **Contrast:** every text/UI value below was computed for WCAG **AA**, biased to the high end for
> daylight (see the ratio comments). Resting control borders are intentionally subtle and rely on
> **fill + focus state** to identify the control (WCAG 1.4.11 exception); the focus state carries
> the high-contrast boundary.
>
> Three laws this encodes: **legible-in-sunlight · one confident accent · reach & repetition.**

---

## 1. Color — Brand (Teal / deep cyan)

The single confident accent. Used *reserved & intentionally*: primary CTA, active nav, selected
& interactive states, key affordances. **Never** carries state meaning (that's functional color).

```
--teal-50:   #F0FDFA   /* selected/active background tint */
--teal-100:  #CCFBF1   /* hover tint, subtle fills */
--teal-200:  #99F6E4
--teal-300:  #5EEAD4
--teal-400:  #2DD4BF   /* dark-mode accent (see §9) */
--teal-500:  #14B8A6
--teal-600:  #0D9488
--teal-700:  #0F766E   /* ★ PRIMARY — text/icon on white 5.47:1, white-on-teal 5.47:1 (AA✓) */
--teal-800:  #115E59   /* primary hover (filled) */
--teal-900:  #134E4A   /* primary active/pressed — white-on 9.48:1 */
```

Semantic accent tokens:
```
--color-accent-primary:         var(--teal-700);   /* #0F766E */
--color-accent-primary-hover:   var(--teal-800);   /* #115E59 */
--color-accent-primary-active:  var(--teal-900);   /* #134E4A */
--color-accent-onPrimary:       #FFFFFF;           /* label on filled teal — 5.47:1 ✓ */
--color-accent-surface:         var(--teal-50);    /* selected row / active-nav indicator bg */
--color-accent-surface-hover:   var(--teal-100);
```
> MUI: `palette.primary.main = #0F766E`, `dark = #115E59`, `contrastText = #FFFFFF`. `secondary`
> stays on teal (no second brand tone) so existing `color="secondary"` CTAs remain on-brand.

## 2. Color — Neutrals (daylight-tuned, cool slate)

Cool grays complement teal; the ink is near-black for max sunlight legibility.

```
--slate-50:  #F8FAFC   /* foundation background */
--slate-100: #F1F5F9   /* sunken surface (wells) */
--slate-200: #E2E8F0   /* hairline border / divider */
--slate-300: #CBD5E1   /* resting control border */
--slate-400: #94A3B8   /* placeholder / disabled text (non-essential) */
--slate-500: #64748B
--slate-600: #475569   /* secondary text — 7.58:1 on white (AA✓, AAA) */
--slate-700: #334155
--slate-800: #1E293B
--slate-900: #0F172A   /* ★ INK — primary text, 17.85:1 on white */
```

Semantic surface/text/border tokens (light mode):
```
--color-bg-primary:      var(--slate-50);    /* #F8FAFC — app foundation (never pure white) */
--color-bg-secondary:    #FFFFFF;            /* cards / paper / sheets */
--color-bg-tertiary:     var(--slate-100);   /* #F1F5F9 — input wells, sunken */
--color-bg-inverse:      var(--slate-900);

--color-text-primary:    var(--slate-900);   /* #0F172A — 17.85:1 */
--color-text-secondary:  var(--slate-600);   /* #475569 — 7.58:1 */
--color-text-tertiary:   var(--slate-400);   /* #94A3B8 — placeholder/disabled only */
--color-text-inverse:    #FFFFFF;
--color-text-link:       var(--teal-700);

--color-border-primary:  var(--slate-200);   /* #E2E8F0 — card edge / divider (decorative) */
--color-border-control:  var(--slate-300);   /* #CBD5E1 — resting input/control edge */
--color-border-focus:    var(--teal-700);    /* focus border, paired with the glow ring */
```

## 3. Color — Functional (meaning only, muted, never neon)

Distinct from teal and from each other; **always paired with an icon/label** for color-blind
users (state is never color-alone). Three states only — green / amber / red — plus a rare info.

```
/* SUCCESS — availability / "go" / ok / paid */
--color-success:        #15803D;   /* green-700 — white-on 5.02:1 (AA✓) */
--color-success-fg:     #166534;   /* on success-bg — 6.49:1 */
--color-success-bg:     #DCFCE7;   /* chip / container tint */

/* WARNING — caution / using extra cushion / nearing expiry */
--color-warning:        #B45309;   /* amber-700 — white-on 5.02:1 (AA✓) */
--color-warning-fg:     #92400E;   /* on warning-bg — 6.37:1 */
--color-warning-bg:     #FEF3C7;

/* ERROR — urgency / dispute / overbooking block / cancel */
--color-error:          #B91C1C;   /* red-700 — white-on 6.47:1 (AA✓) */
--color-error-fg:       #991B1B;   /* on error-bg — 6.80:1 */
--color-error-bg:       #FEE2E2;

/* INFO — rare neutral notice (NOT the teal brand) */
--color-info:           #0369A1;   /* sky-700 — white-on 5.93:1 */
--color-info-bg:        #E0F2FE;
```
> MUI: `success.main=#15803D`, `warning.main=#B45309`, `error.main=#B91C1C`, `info.main=#0369A1`,
> each `contrastText=#FFFFFF`.

## 4. Color — Overlay & Focus

```
--color-surface-overlay:  rgba(15, 23, 42, 0.45);   /* scrim behind sheets/modals (slate-900 α) */
--shadow-focus:           0 0 0 3px rgba(15, 118, 110, 0.28);  /* teal-700 @ 28% — focus ring */
```

---

## 5. Typography — Manrope, weight-driven, numeric-aware

Faces (kept from current system):
```
--font-family-display:  "Manrope", "Inter", system-ui, sans-serif;
--font-family-body:     "Manrope", "Inter", system-ui, sans-serif;
--font-family-mono:     "Roboto Mono", ui-monospace, monospace;   /* codes / IDs */
```

Weights:
```
--font-weight-normal:    400;   /* body */
--font-weight-medium:    500;   /* labels, emphasis */
--font-weight-semibold:  600;   /* headings, buttons, numbers */
--font-weight-bold:      700;   /* display, h1/h2 */
--font-weight-x:         800;   /* hero balance figures only */
```

Scale (mobile-first; base 16px is deliberately large for outdoor legibility). `size / line-height`:
```
--text-display:  40px / 44px   700  -0.02em   /* hero balance, big totals */
--text-h1:       32px / 40px   700  -0.02em
--text-h2:       26px / 32px   700  -0.01em
--text-h3:       22px / 28px   600  -0.01em
--text-title:    18px / 24px   600   0
--text-body-lg:  17px / 26px   400   0
--text-body:     16px / 24px   400   0        /* base */
--text-body-sm:  14px / 20px   400   0
--text-label:    13px / 16px   500  +0.01em
--text-overline: 12px / 16px   600  +0.06em   uppercase  /* "PASO 2 DE 3" */
```

Line-height & tracking helpers:
```
--line-height-tight:    1.15;   --line-height-normal:  1.5;    --line-height-relaxed: 1.65;
--letter-spacing-tight: -0.02em; --letter-spacing-normal: 0;    --letter-spacing-wide: 0.06em;
```

**Numeric / money treatment (the system's signature).** Any financial figure or count uses tabular
lining figures so digits align and don't jitter as values change:
```
--numeric-feature-settings: "tnum" 1, "lnum" 1;   /* tabular + lining */
--numeric-weight:           600;                  /* 700–800 for the dominant figure */
--numeric-tracking:         -0.01em;
```
> The `MoneyText` primitive (§8) applies these at `--text-display`/`--text-h1` sizes; color follows
> *functional* semantics (neutral ink / success / error), never teal.

---

## 6. Spacing — 8px base (4px half-step)

Generous by intent — we spend whitespace rather than cram density.
```
--space-0:  0;     --space-px: 1px;
--space-0_5: 4px;  --space-1: 8px;   --space-1_5: 12px; --space-2: 16px;
--space-3: 24px;   --space-4: 32px;  --space-5: 40px;   --space-6: 48px;
--space-8: 64px;   --space-10: 80px; --space-12: 96px;
```
Anchors: card padding `--space-3` (24) · screen gutter `--space-2`/`--space-3` · section gap
`--space-3` · min touch target **48px** (`--space-6`) · primary button height 48px.

## 7. Layout — radius, elevation, breakpoints

Radius (brief: 12 controls / 16 containers):
```
--radius-sm:    8px;     /* small chips, tags */
--radius-md:    12px;    /* ★ controls — buttons, inputs, segmented toggles */
--radius-lg:    16px;    /* ★ containers — cards, dialogs */
--radius-xl:    20px;    /* bottom-sheet top corners */
--radius-full:  9999px;  /* avatar, status chips, badges, FAB */
```

**Elevation — structure-first.** Resting surfaces have **no shadow**; structure comes from a
hairline border + surface tint (reads in any light). Real shadow is reserved for true overlays.
```
--shadow-none:        none;                                  /* ALL resting cards/surfaces */
--shadow-overlay-sm:  0 4px 12px rgba(15,23,42,0.08),
                      0 1px 2px rgba(15,23,42,0.04);         /* menus, popovers, dropdowns */
--shadow-overlay-md:  0 12px 32px rgba(15,23,42,0.14);       /* modals / dialogs */
--shadow-sheet:       0 -8px 30px rgba(15,23,42,0.12);       /* bottom sheets (upward cast) */
--shadow-focus:       0 0 0 3px rgba(15,118,110,0.28);       /* = §4 */
```
> MUI `shadows[]`: index 0 = none; map card elevation to `none` + border; reserve higher indices for
> Menu/Popover (`overlay-sm`), Dialog (`overlay-md`), and the BottomSheet component (`shadow-sheet`).

Breakpoints (MUI defaults — the real ones in use; mobile-first):
```
--bp-xs: 0;     --bp-sm: 600px;   --bp-md: 900px;   --bp-lg: 1200px;   --bp-xl: 1536px;
```
Content widths:
```
--max-width-content: 640px;   /* single-column forms/sheets cap */
--max-width-page:    1200px;  /* admin desktop two-column shell */
```

## 8. Motion

```
--duration-instant: 50ms;  --duration-fast: 150ms;  --duration-normal: 250ms;
--duration-slow: 400ms;    --duration-slower: 600ms;
--easing-default: cubic-bezier(0.4, 0, 0.2, 1);
--easing-out:     cubic-bezier(0, 0, 0.2, 1);
--easing-in:      cubic-bezier(0.4, 0, 1, 1);
--easing-sheet:   cubic-bezier(0.32, 0.72, 0, 1);   /* bottom-sheet slide */
```
Usage: page fade-in `--duration-normal --easing-out`; sheet slide `--duration-slow --easing-sheet`;
hover/press `--duration-fast`. **All motion honors `prefers-reduced-motion: reduce`** (collapse to
opacity-only or instant).

---

## 9. Component Tokens (the shared primitive layer)

| Primitive | Tokens |
|---|---|
| **Button / primary** | bg `--teal-700` · text `#FFF` · hover `--teal-800` · active `--teal-900` · radius `--radius-md` · min-height 48 · weight 600 · `text-transform:none` · **no shadow** · disabled bg `--slate-200` / text `--slate-400` |
| **Button / secondary (outline)** | text `--teal-700` · border `--teal-700` 1px · hover bg `--teal-50` |
| **Button / ghost** | text `--slate-700` · hover bg `--slate-100` |
| **Input / control** | bg `#FFFFFF` · border `--color-border-control` (`#CBD5E1`) 1px · radius `--radius-md` · min-height 48 · text `--text-body` · placeholder `--slate-400` · **focus:** border `--teal-700` + `--shadow-focus` |
| **Card / SectionCard** | bg `#FFFFFF` · border `--slate-200` 1px · radius `--radius-lg` · padding `--space-3` (24) · **shadow none** |
| **MoneyText** | `--numeric-feature-settings` · size `--text-display`/`--text-h1` · weight 700–800 · color: neutral `--slate-900`, positive `--color-success`, negative/owed `--color-error` |
| **StatusChip** | radius `--radius-full` · height 28 · weight 600 · `{state}-bg` + `{state}-fg` + leading icon · never teal |
| **AlertCard** | warning/error bg tint + fg + icon · border `{state}` 1px · radius `--radius-lg` · top-of-screen, blocks attention |
| **BottomSheet** | bg `#FFFFFF` · top radius `--radius-xl` · `--shadow-sheet` · scrim `--color-surface-overlay` · slide `--easing-sheet` |
| **Menu / Popover** | bg `#FFFFFF` · radius `--radius-lg` · `--shadow-overlay-sm` |
| **BottomNav / rail item** | inactive `--slate-500` · **active** `--teal-700` text + `--teal-50` indicator · badge `--color-error`/`--color-warning` |
| **FAB** | bg `--teal-700` · `#FFF` icon · radius `--radius-full` · `--shadow-overlay-sm` (it floats) |

---

## 10. Dark Mode — DEFINED, NOT BUILT (deferred)

> Per the brief, dark tokens are specified here but **not** wired into `theme.ts` or shipped in this
> pass (no `palette.mode` switch, no toggle). They exist so the future build is a fill-in, not a
> redesign. Dark is a **cool, deep slate** (never pure black); ink is off-white (never pure white);
> teal lightens to hold contrast; functional colors lighten; shadows deepen.

```
[data-theme="dark"] {
  --color-bg-primary:     #0B1220;   /* deep cool slate foundation */
  --color-bg-secondary:   #131C2E;   /* cards / sheets */
  --color-bg-tertiary:    #0E1626;   /* wells */
  --color-bg-inverse:     #E2E8F0;

  --color-text-primary:   #E2E8F0;   /* off-white, not #FFF */
  --color-text-secondary: #94A3B8;
  --color-text-tertiary:  #64748B;
  --color-text-inverse:   #0F172A;
  --color-text-link:      #2DD4BF;

  --color-border-primary: #1E293B;   /* hairline */
  --color-border-control: #334155;
  --color-border-focus:   #2DD4BF;

  --color-accent-primary:        #2DD4BF;   /* teal-400 — accents/text on dark */
  --color-accent-primary-hover:  #5EEAD4;
  --color-accent-onPrimary:      #0F172A;   /* dark text on bright teal fill */
  --color-accent-surface:        rgba(45,212,191,0.12);

  --color-success: #4ADE80;  --color-success-bg: rgba(74,222,128,0.14);
  --color-warning: #FBBF24;  --color-warning-bg: rgba(251,191,36,0.14);
  --color-error:   #F87171;  --color-error-bg:   rgba(248,113,113,0.14);
  --color-info:    #38BDF8;  --color-info-bg:    rgba(56,189,248,0.14);

  --color-surface-overlay: rgba(0,0,0,0.6);
  --shadow-overlay-sm: 0 4px 12px rgba(0,0,0,0.4);
  --shadow-overlay-md: 0 12px 32px rgba(0,0,0,0.5);
  --shadow-sheet:      0 -8px 30px rgba(0,0,0,0.45);
  --shadow-focus:      0 0 0 3px rgba(45,212,191,0.34);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* mirror the [data-theme="dark"] block when built */ }
}
```

---

## 11. Migration notes (old → new)

| Concern | Luminous SaaS (old) | Elegant Field Minimalism (new) |
|---|---|---|
| Primary | Indigo `#5850EC` | **Teal `#0F766E`** |
| Ink / body | `#111827` / `#6B7280` | `#0F172A` / `#475569` (stronger secondary) |
| Background | `#F9FAFB` | `#F8FAFC` (cooler) |
| Success / Error | `#1E9E6A` / `#BA1A1A` | `#15803D` / `#B91C1C` + **new amber warning `#B45309`** |
| Elevation | soft ambient shadows everywhere | **structure-first**: borders; shadow only on overlays |
| Card radius | 16 | 16 (kept) · **controls 8 → 12** |
| Type | Manrope | Manrope (kept) + **explicit numeric/tabular treatment** |
| Source of truth | `docs/DESING.md` | **this file** → ported to `theme.ts` in Phase 6; `DESING.md` retired |
```
