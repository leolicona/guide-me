# Build Tasks: Turistear Ya! Design System (Whole-Product Refactor)

Generated from: .design/design-system/DESIGN_BRIEF.md (+ INFORMATION_ARCHITECTURE.md, DESIGN_TOKENS.md)
Date: 2026-06-25
Philosophy: **Elegant Field Minimalism** — teal accent, structure-first elevation, money-reads-first,
mobile-first / one-handed / daylight-legible. Scope: **fresh tokens + deep refactor** across all
feature modules. Dark mode documented, **not built**.

> Ordering: foundation (token engine + primitives) → validate the aesthetic on the highest-visibility
> money screens → sweep features → polish/a11y → review. Each task is a vertical slice. Because the
> MUI theme cascades, most feature screens re-skin for free once Foundation lands — feature tasks are
> only where bespoke/hardcoded styling or new primitives are needed (the 4 known drift files +
> per-screen archetype adoption).

## Foundation
- [x] **Rewrite the theme (establishes the whole aesthetic)**: Replace `app-turistear/src/config/theme.ts` with the **Elegant Field Minimalism** system from `DESIGN_TOKENS.md` — teal `#0F766E` primary, cool-slate neutrals (ink `#0F172A`), functional green/amber/red, **structure-first elevation** (`shadows[1]=none`; overlay shadows only on Menu/Dialog/sheet), 12px control / 16px container radius, Manrope scale, 48px control heights, teal focus ring. Add component defaults for `MuiButton` (no shadow, 48 min-height), `MuiOutlinedInput` (teal focus bloom), `MuiCard`/`MuiPaper` (border + `boxShadow:none`), `MuiChip`. _Modifies: `theme.ts`. This single task re-skins ~90% of the app via cascade._ _Risk-first: validate teal + structure-first look on one existing screen before proceeding._
- [x] **CSS-variable layer + fonts**: Emit the `DESIGN_TOKENS.md` custom properties (`--color-*`, `--space-*`, `--radius-*`, `--shadow-*`, motion) into a `tokens.css` (or via MUI `cssVariables`) so non-MUI/sx code can reference them; ensure **Manrope** is loaded (weights 400/500/600/700/800). _New: `tokens.css` / `index.css` update._
- [x] **Promote `BottomSheet` to a shared primitive layer**: Create `src/components/` and move `features/filters/components/BottomSheet.tsx` there as the canonical overlay (top radius 20, `--shadow-sheet`, scrim, `--easing-sheet` slide, focus-trap, mobile Back dismiss). Update the `features/filters` importer + re-export. _Modifies: filters; New: `src/components/BottomSheet`._
- [x] **`MoneyText` primitive (signature element)**: New `src/components/MoneyText.tsx` — tabular-lining Manrope, sizes `display`/`h1`, weight 700–800, color by semantics (neutral ink / success / error), SR label prop ("Saldo a entregar: $X"). _New component — the visual proof of "money reads first."_
- [x] **`SectionCard` primitive**: New `src/components/SectionCard.tsx` — white surface, hairline border, 16px radius, 24px padding, **no resting shadow**. Replaces ad-hoc `Card`/`Paper` usage going forward. _New component._
- [x] **`StatusChip` + `AlertCard` primitives**: New `src/components/StatusChip.tsx` (functional bg-tint + fg + leading icon, never teal) and `src/components/AlertCard.tsx` (top-of-screen, warning/error semantics, blocks attention). Covers states: paid/booking/cancelled, available/full, pending/dispute. _New components._

## Core UI (validate the aesthetic on the money screens first)
- [x] **Caja (`/balance` + `/cash`)**: Adopt `MoneyText` for the dominant "Efectivo a entregar" figure, `SectionCard` for breakdown, `AlertCard` for sign/dispute & pending drops, bottom-anchored teal **Entregar efectivo** CTA. Verify the superseded `.design/caja-module` intent is satisfied by the new tokens. _Modifies: `features/cash/*`, `BalancePage`, `CashBalancesPage`, `CashDropDetailPage`._
- [x] **POS checkout (`/pos/checkout`)**: Money-first total via `MoneyText`; amount-driven CTA label (Finalizar Pago / Registrar Reserva) as the single teal bottom action; segmented payment toggle on new tokens. _Modifies: `PosCheckoutPage`, `features/pos`._
- [x] **POS catalog + Bottom Sheet (`/pos`, `/pos/service/:id`)**: Re-skin catalog cards to `SectionCard` + availability `StatusChip`; refactor `PosDatePickerSheet` to the promoted `BottomSheet`; teal active states on date strip/category chips. Clean hardcoded hex in `PosCatalogPage.tsx`. _Modifies: `PosCatalogPage`, `PosServicePage`, `features/pos/components/PosDatePickerSheet.tsx`._

## Interactions & States (sweep the remaining feature modules)
- [x] **Auth screens**: Re-skin login/register/verify/forgot/reset/invite to the new tokens; clean hardcoded hex + `elevation={0}` in `layout/AuthLayout.tsx` (use border, not elevation). Teal primary CTAs, 48px inputs with focus bloom. _Modifies: `layout/AuthLayout.tsx`, `features/auth/*` (11), auth pages._
- [x] **App shell (nav + account surface)**: Re-skin `AppLayout`, `BottomNav`/rail, `AccountAvatarChip`, `AccountMenu` — teal active item + `teal-50` indicator, functional-color badges (Caja/Ventas), structure-first surfaces, no top bar. _Modifies: `layout/*`._
- [x] **Catalog / service wizard (`/catalog`)**: Largest feature (15 cmpts) — adopt `SectionCard`, `StatusChip`, and a shared **Wizard shell** (fixed header + "PASO n DE N" overline + progress + fixed footer) for service creation. Build `src/components/WizardShell.tsx` if reused by Affiliate setup. _Modifies: `features/catalog/*`; New: `WizardShell`._
- [x] **Affiliates (`/affiliates`) + Affiliate setup wizard**: Reuse `WizardShell`; `MoneyText` for commissions/balances; `StatusChip` for active/suspended. _Modifies: `features/affiliates/*`._
- [x] **Ventas / folios + bookings**: Folio list/detail to list-archetype (`StatusChip` paid/booking/cancelled, `MoneyText` amounts, audit timeline); bookings (Reservas) cards with expiry-urgency `AlertCard`/border + WhatsApp action. _Modifies: `features/folios`, `features/bookings`, folio pages._
- [x] **Agents, schedules, scanner, dashboard (Hoy), reports, settings**: Token-cascade pass — replace any remaining bespoke `Card`/`Paper`/color usage with primitives; scanner result screen ✓/✗ on functional colors; Hoy queue cards on `SectionCard`; reports table/filters legible at the new scale. _Modifies: `features/agents`, `features/schedules`, `features/scanner`, `features/dashboard`, `features/reports`, `DateRangeSheet.tsx` (clean hardcoded hex), settings._
- [x] **`DateRangeSheet` drift cleanup**: Refactor `features/filters/components/DateRangeSheet.tsx` onto the promoted `BottomSheet` + tokens (remove hardcoded hex). _Modifies: filters._

## Responsive & Polish
- [x] **Responsive pass**: Verified live at true 375 / 768 / 1280 (playwright-cli + `setViewportSize`) — single-column mobile and rail↔bottom-bar swap both confirmed; reports uses summary-split + full-width table on desktop. **Found 2 mobile defects** (Catálogo header button/avatar collision + service-title overflow at 375px) — logged as Should-Fix in `DESIGN_REVIEW.md`. Checkout sticky-CTA-vs-BottomNav not visually verified (not captured on live tenant).
- [~] **Accessibility pass**: Spot-checked live — teal focus bloom confirmed on focused fields (`review-register-password-focus-1280.png`); functional color is icon-paired (✓/✗ on status chips) not color-alone; CTAs/nav targets read ≥48px. _Still to verify in code: focus trap+restore in sheets/modals, `MoneyText`/`StatusChip` SR labels carry the state word, `prefers-reduced-motion` collapses motion._
- [x] **Docs reconciliation**: Update `CLAUDE.md` design section to the shipped system (teal, Manrope, `#F8FAFC`, structure-first, 12/16 radius); retire/redirect `docs/DESING.md` to `DESIGN_TOKENS.md`. _Modifies: `CLAUDE.md`, `docs/DESING.md`._

## Review
- [x] **Design review**: Run `/design-review` against `.design/design-system/DESIGN_BRIEF.md` once the money screens + shell are built — capture POS, Caja, a list, and a wizard across mobile/tablet/desktop.
