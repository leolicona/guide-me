# Design Review: GuideMe Design System (Whole-Product)

Reviewed against: `.design/design-system/DESIGN_BRIEF.md`
Philosophy: **Elegant Field Minimalism** (teal-accented, structure-first, money-reads-first)
Date: 2026-06-25 (updated 2026-06-26 — full authenticated pass)
Reviewer environment: live app at `https://app.turistearya.com` (authenticated as admin
`leolicona.dev@gmail.com`) captured with **playwright-cli** at true viewports, plus code review of the
full refactor.

## Screenshots Captured

Captured with **playwright-cli** at **true viewports** (`page.setViewportSize` via `run-code`; the
`resize` command was unreliable and would stick at one width — `setViewportSize` was the robust path)
and **persisted** to `.design/design-system/screenshots/`. Viewport width verified via
`window.innerWidth` before every shot. This run **resolves both prior limitations**: real responsive
breakpoints *and* the authenticated money-first screens are now covered.

| Screenshot | Breakpoint | What it shows |
| --- | --- | --- |
| `review-login-{desktop-1280,tablet-768,mobile-375}.png` | 3 viewports | Auth card, teal wordmark/CTA/links, hairline border, no shadow |
| `review-register-{desktop-1280,tablet-768,mobile-375}.png` | 3 viewports | 5-field form, single-column mobile reflow |
| `review-register-password-focus-1280.png` | Interactive | **Teal focus bloom** + **amber `PasswordStrength` meter** ("Regular", `#B45309`) |
| `review-dashboard-{desktop-1280,tablet-768,mobile-375}.png` | 3 viewports | "Hoy" — attention cards, bottom-nav vocabulary (Hoy·Vender·Escáner·Ventas·Caja) |
| `review-caja-cash-{desktop-1280,tablet-768,mobile-375}.png` | 3 viewports | **Caja** — money-first hero, semantic green commissions, teal CTA only |
| `review-pos-{desktop-1280,tablet-768,mobile-375}.png` | 3 viewports | **POS / Vender** — date pills, filter chips, green availability chips, "Desde" price |
| `review-folios-{desktop-1280,tablet-768,mobile-375}.png` | 3 viewports | **Folios / Ventas** — `FolioStatusChip` (green paid / red cancelled), Total/Pagado figures |
| `review-catalog-{desktop-1280,mobile-375}.png` | 2 viewports | **Catálogo** — service list, amber commission flag, action links |
| `review-reports-{desktop-1280,mobile-375}.png` | 2 viewports | **Reportes** — admin summary split + full-width seller table, `settlementColor` fix |

> Not captured: **POS checkout** (`/pos/checkout`) and the **service/affiliate wizards** — both require
> creating cart/record state on the **live production tenant**, which I avoided to not mutate real data.
> They are covered by code review (`WizardShell` primitive, sticky-footer CTA) and flagged below.

## Summary

The **Elegant Field Minimalism** system holds up beautifully on the real, data-populated screens — not
just the auth surface. The brief's central thesis is **proven on Caja**: "Efectivo por entregar
**$1,582.00**" reads first in large neutral-ink tabular Manrope, "Comisiones ganadas **$418.00**" is
semantic **green** (`#15803D`), and teal appears *only* on the "Entregar efectivo" CTA and the active
nav — the **teal-money anti-pattern is genuinely purged** everywhere (Caja, POS, folios, reports). The
**rail↔bottom-bar responsive swap works** (mobile bottom nav → desktop left rail), and `FolioStatusChip`
renders consistent icon-paired functional color (green ✓ paid / red ✗ cancelled). Biggest real findings:
two **mobile (375px) layout defects on the Catálogo header** — a clipped action button colliding with
the avatar chip, and long service titles overflowing without truncation.

## Must Fix

*(None.) No broken functionality, accessibility-blocking, or major brief deviations were found on any
captured screen. The code-level refactor is green and the visual system is faithful.*

## Should Fix

1. ~~Catálogo header: action button clipped + colliding with the avatar at 375px.~~ **FIXED.** See
   `review-catalog-mobile-375.png` for the original defect — the teal "Nuevo servicio" button was cut off
   and the "L" avatar chip overlapped it. Root cause: the page placed a right-aligned action under the
   shell's fixed mobile avatar, violating its "titles stay left-aligned" contract. _Fix
   (`pages/CatalogListPage.tsx`): the header now stacks on `xs` (title, then a full-width action below
   the avatar zone) and keeps the side-by-side row from `md` up, where the avatar lives in the rail._

2. ~~Long service titles overflow horizontally at 375px.~~ **FIXED.** "Especial de media noche Noche de
   Leyenda$" was clipped at the right edge. Root cause: the title carried `noWrap` but was rendered as
   `component={RouterLink}` (an inline `<a>`), and `text-overflow: ellipsis` doesn't apply to inline
   elements. _Fix (`features/catalog/components/ServiceRow.tsx`): added `display: 'block'` so `noWrap`
   truncates within the `minWidth: 0` parent._

3. **Verify the POS checkout sticky CTA vs. the mobile BottomNav (code-level, not visually confirmed).**
   `PosCheckoutPage` wraps the confirm button in `position: sticky; bottom: 0`, while `AppLayout` renders
   a `position: fixed; bottom: 0` BottomNavigation. On a 375px phone these two bottom-anchored elements
   can overlap. _Not captured (would require a live cart on production). Verify on a real cart and, if
   they collide, raise the footer above the nav (`bottom: 56px` on `xs`) or hide BottomNav on checkout._

## Could Improve

1. **Single-column money screens leave a wide right gutter at ≥1280.** See
   `review-caja-cash-desktop-1280.png` — the agent Caja column is left-aligned with large empty space on
   the right. On-brand and readable, but the content could center or cap its measure for balance. Low
   priority.
2. **Reports "Comisión" column is rendered in secondary gray vs. ink for Ventas/Saldo.** See
   `review-reports-desktop-1280.png`. Reads as intentional hierarchy (commission is secondary), but
   confirm it's deliberate and consistent with the money-emphasis rules.
3. **Dark mode** is defined (`DESIGN_TOKENS.md §10`) but not built — expected and out of scope.

## What Works Well

- **The money-first thesis is real, on real data.** Caja leads with a large neutral-ink figure;
  "Comisiones ganadas" is semantic green; every Total/Pagado/Saldo across folios and reports is neutral
  tabular Manrope. **No money is teal anywhere.** This is the single most important brief outcome and it
  landed.
- **Accent discipline holds under load.** Across busy screens (POS catalog, reports table, folios list)
  teal appears *only* on the active nav item, the one primary CTA, active date/filter pills, links, and
  toggles. Nothing decorative is teal.
- **The responsive rail↔bottom-bar swap works.** Mobile shows the 5-item bottom nav; desktop promotes it
  to a left rail with the org monogram and avatar — a genuine reorganization, not a shrink. Verified at
  real 375 / 768 / 1280 widths.
- **Functional color is consistent and icon-paired.** Green ✓ "Pagado" / "Disponible" / "Activo", red ✗
  "Cancelado" / "Desactivar", amber "Flexible +3%" commission flag and the password-strength meter — all
  distinct from teal and never color-alone.
- **Structure-first elevation reads correctly** on every surface: hairline-bordered white cards, no
  resting shadow, over the off-white `#F8FAFC` field. No glassmorphism, no soft-shadow cards.
- **The consolidations are visibly paying off:** one `FolioStatusChip` driving consistent status pills,
  the shared primitive layer (`MoneyText`, `SectionCard`, `StatusChip`, `AlertCard`, `BottomSheet`,
  `WizardShell`), and the `settlementColor` fix (Saldo positives in ink, not teal) all show up correctly
  on the live screens.

---

## Limitations of this review

Both prior environment constraints are now resolved:

1. ~~Authenticated screens are gated~~ — **RESOLVED.** Logged in to the live tenant (the user ran the
   password step; my safety rules prevent me from entering an authentication password myself) and
   captured Caja, POS, folios, catalog, reports, and dashboard with real data.
2. ~~`resize_window` was a no-op~~ — **RESOLVED.** `playwright-cli` + `page.setViewportSize` captured all
   breakpoints at true widths and persisted them to `screenshots/`.

**Only remaining gap:** POS **checkout** and the **wizards** weren't captured to avoid creating records
on the live production tenant — re-run those against a local/staging seed (or a disposable cart) to
close out Should-Fix #3 visually.
