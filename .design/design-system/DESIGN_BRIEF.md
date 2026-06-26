# Design Brief: GuideMe Design System (Whole-Product)

> Scope: a **product-wide** design system, not a single feature. It establishes the unifying
> philosophy, visual language, and token foundation that every one of GuideMe's 16 feature
> modules inherits. Direction is a **fresh synthesis** (replacing the shipped "Luminous SaaS"
> indigo theme), with a **deep refactor** mandate across the app. Dark mode is **documented but
> not built** in this pass.

## Problem

GuideMe is used by tourism sales agents *in the field* — on a phone, one-handed, often outdoors
in bright sun, while handling physical cash and a queue of customers. Today the app's look was
assembled feature-by-feature: an indigo theme that drifts from its own documentation, soft
shadows that disappear in sunlight, primitives re-invented inside individual features, and money
figures that don't visually dominate the screens that are *about money*. The result is an
interface that is pleasant indoors but works against the person standing on a dock at noon trying
to close a sale before the boat leaves — and an admin who can't train an agent by pointing,
because the same action looks different on different screens.

The human friction: **the tool doesn't feel trustworthy or fast enough for the moment it's used
in.** An agent holding someone else's cash needs to glance, trust the number, and tap once.

## Solution

A single, coherent visual system — *an elegant field instrument* — that makes every GuideMe
screen legible at arm's length in daylight, reachable with one thumb, and fast for the handful of
loops agents repeat all day (sell, scan, settle). It does this through restraint, not addition:
neutral ink on light surfaces, structure drawn with hairline borders instead of shadows that wash
out, a single confident **teal** that always means "this is the action / the active thing," and
**Manrope** numerals sized and weighted so a balance or a remaining-spots count is the loudest
thing on screen. Sophistication comes from what's removed; ruggedness comes from contrast, size,
and reach. The same component, verb, and color mean the same thing everywhere, so an admin can
train an agent by pointing.

## Experience Principles

> Three principles. Each resolves the central tension of this system: **elegant minimalism that is
> also a rugged outdoor tool.**

1. **Legible-in-sunlight over decorative-indoors** — Hierarchy is built from contrast, weight, and
   size, never from soft shadow or subtle tint that vanishes in daylight. If a choice looks
   refined on a desk but disappears on a dock, the dock wins. Money and counts are the largest,
   highest-contrast elements on any screen that concerns them.

2. **One confident accent over many** — The interface is mostly neutral ink on light surface. Teal
   is *reserved* for the next action, the active state, and interactive affordances — so the eye
   is guided to the next tap (which also serves speed). Functional colors (green/amber/red) carry
   *meaning only* and never compete with the brand accent.

3. **Reach and repetition over screen real-estate** — Primary actions live where a thumb lands
   (bottom-anchored), touch targets are ≥48px, and the sell/scan/settle loops are tuned for
   minimum taps and muscle memory. We spend whitespace and target size generously rather than
   cramming density; speed comes from predictability, not compactness.

## Aesthetic Direction

- **Philosophy**: **Elegant Field Minimalism** — sophisticated, restrained minimalism hardened
  for outdoor, one-handed, cash-in-hand use. Trust expressed as clarity.
- **Tone**: Calm, confident, trustworthy, precise. Never playful, never punitive, never busy. The
  register of a well-made instrument.
- **Reference points**: Stripe Dashboard and Mercury (calm financial clarity, restrained accent);
  Linear (typographic discipline, structural borders over shadow); transit/field apps that stay
  readable in sun (large type, high contrast, thumb ergonomics). Teal-as-trust, travel-adjacent.
- **Anti-references**: The shipped indigo "Luminous SaaS" soft-shadow look; consumer travel apps
  with hero photography and gradients; dense financial spreadsheets/data-grids on mobile; neon or
  saturated "dashboard" palettes; pill-heavy consumer-app softness that reads as un-serious.

## Existing Patterns

What's in the codebase today. The fresh system **replaces** the indigo token layer but **keeps**
the structural conventions (MUI theming, feature-folder layout, BottomSheet pattern, Material
Symbols). It must refactor *toward* the new tokens, not bolt on beside them.

- **Framework**: React 18 + TypeScript + Vite (CRXJS), **MUI v6** with `createTheme`
  (`cssVariables: true`). Theme lives at `app-guideme/src/config/theme.ts`.
- **Typography (current → keep face)**: Manrope (`"Manrope", "Inter", sans-serif`). Hierarchy via
  weight (400 body / 600 emphasis / 700 headings), `-0.02em` heading tracking. **Kept**; the fresh
  system re-tunes the scale and adds an explicit numeric/tabular treatment.
- **Colors (current → REPLACED)**: Indigo primary `#5850EC`, charcoal ink `#111827`, slate
  `#6B7280`, green `#1E9E6A`, red `#BA1A1A`, bg `#F9FAFB`, hairline `#E5E7EB`. The fresh system
  swaps the brand hue to **teal/deep-cyan**, formalizes amber as the warning step, and rebuilds
  the neutral ramp for daylight contrast. `docs/DESING.md` (the old "Luminous SaaS" YAML) is
  superseded by the Phase 4 `DESIGN_TOKENS`.
- **Spacing**: MUI 8px base; cards pad 24px (`MuiCardContent` override). **Kept and reinforced.**
- **Shape (current → evolved)**: 8px controls / 16px cards → **12px controls / 16px containers.**
- **Elevation (current → REPLACED)**: soft ambient shadows everywhere (`0 4px 20px / 0 10px 30px`)
  → **structure-first**: hairline borders + surface tints for structure; real shadow **only** on
  overlays (bottom sheets, modals, menus).
- **Components**: feature-folder architecture under `src/features/<name>/components`. Shared
  primitives are currently scattered (e.g. `BottomSheet` lives in `features/filters/`). The
  system establishes a **shared primitive layer** (`src/components/` or `src/ui/`).
- **Icons**: Material Symbols (Outlined). **Kept.**
- **Docs to reconcile**: `CLAUDE.md` design section (currently prescribes Inter/Plus Jakarta,
  `#FAFAFA`, "indigo or teal") will be rewritten to match the shipped fresh system.

## Component Inventory

System-level primitives and the cross-cutting components every feature depends on. Feature-specific
screens are catalogued in `INFORMATION_ARCHITECTURE.md` and sequenced in `TASKS.md`.

| Component | Status | Notes |
| --------- | --------------------- | -------- |
| Theme / token foundation (`theme.ts`) | Modify (rebuild palette + elevation) | Teal primary, daylight neutral ramp, structure-first shadows, 12/16 radius, numeric type. |
| Shared primitive layer (`src/components/`) | New | Home for cross-feature primitives extracted from features. |
| `BottomSheet` | Modify (relocate) | Move from `features/filters/` to the shared layer; canonical overlay (one of the few shadow users). |
| `MoneyText` / numeric display | New | Tabular Manrope, large, high-contrast; color follows semantics (neutral / green / red). The system's signature element. |
| `SectionCard` / surface container | New | Hairline-bordered, 16px radius, 24px padding, no resting shadow. Replaces ad-hoc `MuiCard` usage. |
| Primary action button (bottom-anchored) | Modify | Teal filled, ≥48px, thumb-reach placement; the one-confident-accent CTA. |
| `StatusChip` (functional color) | New/Modify | green=available/ok, amber=warning, red=urgency — meaning-only, never teal. |
| Nav shell (BottomNav + account surface) | Modify | Already redesigned (US-UX01–06); re-skin to teal active state, structural borders. |
| Form inputs (text / numeric keypad) | Modify | 12px radius, teal focus ring, white field, large touch height; numeric fields open mobile keypad. |
| Alert / Action card | Modify | Prominent top-of-screen card for sign/dispute & pending drops; uses amber/red semantics, not teal. |
| Empty states | Modify | Quiet, typographic, consistent voice (e.g. "Aún no hay…"). |

## Key Interactions

- **The one-thumb primary action**: every transactional screen ends in a single, bottom-anchored,
  teal, full-width primary button (Cobrar / Entregar / Confirmar / Liquidar). It is the only teal
  *fill* on the screen, so "what do I do next" is never ambiguous.
- **Bottom sheets for configuration**: tapping a catalog card, registering an expense/cash-drop,
  or opening a date picker slides a sheet up over a scrim (one of the few places shadow appears).
  Success auto-closes the sheet and returns control via a Snackbar. (Reuses US-AG31 pattern.)
- **Money reads first**: on Caja, POS checkout, and reports, the dominant figure is the balance /
  total / remaining-spots, rendered in large tabular Manrope. Supporting math (sales − commission
  − expenses = net) is secondary text beneath it.
- **State by color, meaning by color**: availability and "go" are green, caution/urgency are
  amber/red. The teal accent never carries state meaning — it only marks *action* and *active*.
- **Focus & feedback**: interactive elements show a teal focus ring (3px soft outer); taps give
  immediate visual acknowledgment; destructive/irreversible actions (cancel folio, dispute)
  confirm before committing.

## Responsive Behavior

- **Mobile-first, always.** The agent/affiliate experience is designed for a phone held in one
  hand; everything stacks to a single column with bottom-anchored primary actions and a BottomNav.
- **Tablet/Desktop (admin):** the same components reflow to two columns where it aids reconciliation
  (e.g. Caja: alerts + own drawer left, team list right; reports: filters left, table right). The
  account surface moves from a mobile bottom-sheet/top-right chip to a bottom-pinned avatar popover
  (per US-UX03). No component *behavior* changes across breakpoints beyond layout — only the BottomNav
  ↔ side-nav swap and the account surface presentation.
- **Touch targets ≥48px at every breakpoint**; never shrink targets to gain density.

## Accessibility Requirements

- **WCAG AA, biased toward the high end for daylight**: text meets **≥4.5:1** against its surface
  (≥3:1 for large/heading text), and UI/affordance edges meet **≥3:1**. Within AA, prefer the
  darker/stronger option for primary numbers and key actions since they're read in sun. Teal-on-white
  and teal-as-button must clear 4.5:1 for text and 3:1 for UI edges. Functional green/amber/red must
  each pass against white *and* be distinguishable from teal and from each other for color-blind
  users (pair color with icon/label — never color alone for state).
- **Touch & focus**: ≥48px targets; visible teal focus ring on every interactive element; logical
  focus order; focus trapped within open bottom sheets/modals and restored on close.
- **Screen reader**: financial figures announce with their meaning ("Saldo a entregar: $X", "Quedan
  3 lugares"), not bare numbers; status chips announce their state word; sheets/dialogs announce on
  open.
- **Motion**: subtle, purposeful (sheet slide, fade); honor `prefers-reduced-motion`.
- **Language**: Spanish (MX) primary; type scale and components must accommodate longer Spanish
  strings without truncation (i18n is US-L01–L03).

## Out of Scope

- **Dark mode implementation.** Dark tokens are *defined* in Phase 4 (`DESIGN_TOKENS`) but **not
  built** into `theme.ts` or shipped in this pass. No color-mode toggle.
- **New product features or flows.** This system re-skins and refactors what exists; it does not add
  screens, endpoints, or change business logic. Feature behavior (bookings, commissions, scanner,
  etc.) is fixed by `docs/SPEC.md`.
- **Backend / API changes.** Frontend and tokens only.
- **The `caja-module` design exploration** under `.design/caja-module/` — that earlier per-feature
  brief is superseded by this product-wide system (its screens are now built against these tokens).
- **Marketing site, email templates, and the tourist portal's standalone styling** beyond ensuring
  they read from the same token foundation where they share the app shell.
- **Offline QR / Phase 2 product scope** — visual treatment for not-yet-built features is deferred
  until those features are.
