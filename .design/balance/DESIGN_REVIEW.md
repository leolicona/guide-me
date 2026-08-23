# Design Review: `/balance` — Caja across admin, agente and afiliado

Reviewed against: `.design/design-system/DESIGN_BRIEF.md` + `.design/design-system/DESIGN_TOKENS.md`
(no feature brief exists for this route — the design system is the standard).
Philosophy: **Elegant Field Minimalism** — *legible in sunlight · one confident accent · reach & repetition.*
Date: 2026-08-22 · Reviewed on the running app (local dev, seeded), every finding measured.

> **Nothing in this review was introduced by recent work.** All of it pre-dates the folio-surface-parity
> epic (#125–#133); two of the findings are that epic's defect classes recurring on a route it never touched.

## Screenshots Captured

| Screenshot | Breakpoint | Description |
|---|---|---|
| `screenshots/review-balance-agent-desktop-1280.png` | Desktop (1280×800) | Agent `/balance`, full page — signature queue, 3 money cards, Gastos, Entregas |
| `screenshots/review-balance-agent-tablet-768.png` | Tablet (768×1024) | Same, tablet |
| `screenshots/review-balance-agent-mobile-375.png` | Mobile (375×812) | Same, mobile — the field case |
| `screenshots/review-balance-agent-drop-dialog-mobile-375.png` | Mobile (375×812) | "Entregar efectivo" — centred MUI Dialog, not a sheet |
| `screenshots/review-balance-affiliate-desktop-1280.png` | Desktop (1280×800) | Affiliate `/balance` — same screen, Gastos correctly gated off |
| `screenshots/review-balance-affiliate-tablet-768.png` | Tablet (768×1024) | Same, tablet |
| `screenshots/review-balance-affiliate-mobile-375.png` | Mobile (375×812) | Same, mobile — empty "Entregas" state |
| `screenshots/review-balance-admin-redirect-mobile-375.png` | Mobile (375×812) | Admin at `/balance` → silently lands on `/dashboard` |
| `screenshots/review-cash-admin-micaja-desktop-1280.png` | Desktop (1280×800) | The admin's counterpart: `/cash` → "Mi caja" |
| `screenshots/review-cash-admin-micaja-tablet-768.png` | Tablet (768×1024) | Same, tablet |
| `screenshots/review-cash-admin-micaja-mobile-375.png` | Mobile (375×812) | Same, mobile — one card, $0.00, live CTA |
| `screenshots/review-cash-admin-drop-zero-mobile-375.png` | Mobile (375×812) | That CTA's dialog: every control disabled |
| `screenshots/review-cash-admin-equipo-desktop-1280.png` | Desktop (1280×800) | `/cash` → "Equipo" — the admin's team balances |
| `screenshots/review-cash-admin-equipo-mobile-375.png` | Mobile (375×812) | Same, mobile — nested tab rows |

> All screenshots are in `.design/balance/screenshots/`.

## Summary

**Two of the three roles already share one screen, and it is the right one.** Agent and affiliate render
the same `BalancePage`, with exactly one card gated by role (`showExpenses={!isAffiliate}`) — the
capability-not-information pattern the folio work landed on. The break is the third role: **the admin has
no `/balance` at all.** `RoleGuard role={['agent','affiliate']}` bounces them, unexplained, to `/dashboard`,
and their own caja lives inside `/cash` as `TuCajaSection` — a **second, hand-written implementation of the
same payload** that quietly drops the hand-in history, the signature queue and the full balance breakdown.
That is the folio-parity defect, one level up: *one payload written twice by hand always drifts.*

Underneath the route sit two systemic defects it inherits rather than causes, both invisible in a diff and
both measured here: **`color="text.secondary"` is inert under MUI v9** (269 call sites — every muted label
in the product renders at full ink), and **no control in the app shows a keyboard focus ring**.

---

## Must Fix

1. **No visible keyboard focus indicator anywhere (WCAG 2.4.7 AA failure).**
   Tabbed to the primary nav with a real keypress: the focused link carries `Mui-focusVisible` and
   `:focus-visible` is `true`, yet computes `outline: 0px none`, `box-shadow: none`,
   `background: rgba(0,0,0,0)` — **byte-identical to its unfocused peer.** Same result forcing
   `.Mui-focusVisible` onto the "Entregar efectivo" (contained) and "Disputar" (text) buttons: no outline,
   no shadow, no background change. `DESIGN_TOKENS.md §4` defines the ring —
   `--shadow-focus: 0 0 0 3px rgba(15,118,110,0.28)`, "keyboard focus-visible ring, non-text controls" —
   and `app-turistear/src/components/ListRow.tsx:59` is the **only** component in `src/` that applies it;
   `theme.ts` has no `focusVisible` rule at all. Contained buttons additionally lose MUI's default focus
   shadow to `MuiButton.styleOverrides.root.boxShadow: 'none'` + `disableElevation`.
   *Fix: add a `&.Mui-focusVisible { boxShadow: var(--shadow-focus) }` rule to `MuiButtonBase` in
   `theme.ts` so every button, IconButton, Tab and nav link inherits it.*

2. **`color="text.secondary"` is a no-op — every muted label renders at full ink.**
   Measured on the three card labels: `"Efectivo por entregar"`, `"Ventas del turno"`,
   `"Comisiones ganadas"` all compute `rgb(15,23,42)` (= `text.primary`), and the generated emotion rule
   `.css-ip2lr-MuiTypography-root` **contains no `color` declaration at all**. Same for the shift caption
   and every date/label in Gastos and Entregas. On the whole page, exactly three leaf elements render
   `#475569`, and all three are MUI-internal input labels — **zero** of our own call sites take effect.
   Cause: MUI v9 (`@mui/material@^9.0.1`) resolves Typography's `color` through variants named
   `textPrimary | textSecondary | textDisabled` (`Typography.js:69–74`); the dotted path `"text.secondary"`
   matches none and is dropped. Blast radius: **269 call sites across 82 files** (`grep -c 'color="text\.'`).
   The design's whole "money reads first" mechanism depends on the label *receding*, and right now it doesn't.
   See `screenshots/review-balance-agent-mobile-375.png` — the label and the number are the same colour.
   *Fix: codemod `color="text.secondary"` → `color="textSecondary"` (or `sx={{ color: 'text.secondary' }}`),
   then add a measured regression test the way `expectHeadingOutline()` guards the outline.*

3. **State is colour-alone in the Entregas list.** All five chips on the page measured `icon: false`:
   `Pendiente` (bg `#B45309`), `Rechazado` (`#B91C1C`), `Confirmado` (`#15803D`), `Por firmar` (amber
   outline), plus the method chip. `CLAUDE.md` / `DESIGN_TOKENS.md`: functional colour is *"always
   icon-paired — state is never colour-alone."* These are raw MUI `Chip`s
   (`BalancePage.tsx` `DROP_COLOR`/`DROP_LABEL`, `AckChip.tsx`), not the `StatusChip` primitive. Exactly
   the class of defect BUG-035 was, on a route that fix never reached.
   See `screenshots/review-balance-agent-mobile-375.png`. *Fix: route both through `StatusChip` with presets.*

4. **The admin's caja is a second implementation of the seller's caja.**
   Admin → `/balance` lands on `/dashboard` with no explanation (measured: `location.pathname === '/dashboard'`).
   Their caja is `TuCajaSection` inside `/cash`, and it diverges from `BalancePage` in ways nobody decided:
   its hand-in dialog is a near-copy **minus the "Nota (opcional)" field**; the negative-balance state is a
   *different card* with a hardcoded two-row breakdown instead of `CashBoxCard`'s collapsible one (no
   `Saldo anterior`, no `Gastos`, no `Pagos recibidos`); Sales/Commissions cards are conditional
   (`total !== 0`) where the seller's are unconditional; and there is **no Entregas list at all** — an admin
   who hands in cash has no record of it on their own surface. Compare
   `screenshots/review-cash-admin-micaja-mobile-375.png` with `screenshots/review-balance-agent-mobile-375.png`.
   *Fix: same move as the folio surfaces — one `BalanceScreen({ surface })`, with `TuCajaSection` reduced to
   the admin host. Self-authorisation (the "Auto-confirmado" chip, no pending state) is a genuine capability
   difference and stays; the missing history and the divergent dialog are not.*

5. **Heading outline is broken on both surfaces, and `/cash` marks money up as headings.**
   `/balance` (agent) measures `H1 "Caja" → H6 "Pendientes de firma" → H6 "Gastos" → H6 "Entregas"`, and the
   three `SectionCard` money blocks contribute **no heading at all** — their `variant="overline"` labels are
   `<span>`s, so the page's three most important blocks are invisible to heading navigation.
   `/cash` → Equipo measures `H1 "Caja" → H6 "$2,684.00" → H6 "1" → H6 "0"` — **money and counts as
   document structure.** The `variantMapping` fix from #131 only covered `subtitle1/2`; direct
   `variant="h6"` still emits `<h6>`. This is `TECH_DEBT #30`'s territory, now with a measured instance.
   *Fix: `component="h2"` on the section titles, `component="p"` on the stat figures, and give the three
   `SectionCard`s a real (visually-overline) `h2`. Then pin it with `expectHeadingOutline()`.*

## Should Fix

6. **Money bypasses `MoneyText` in two whole cards.** Of 14 money figures on the agent page, only 4 use the
   primitive (32/26/22px, weight 700, `font-variant-numeric: lining-nums tabular-nums`). The other 10 —
   every amount in **Gastos** and **Entregas**, the cash/electronic split, the commission split, and the
   "$200.00 entregado, pendiente de confirmación" line — measure **14–16px, weight 400/500,
   `font-variant-numeric: normal`**. Gastos and Entregas are literally columns of money that do not align
   digit-to-digit, which is the one job tabular figures have. *Fix: `MoneyText` in both list rows.*

7. **The money forms are MUI `Dialog`s, not sheets.** `CLAUDE.md`: *"FormSheet / ConfirmSheet are the
   BottomSheet hosts for ALL entity editing and confirmations (no MUI Dialogs for these)."* Three violations:
   the hand-in dialog in `BalancePage.tsx`, the dispute dialog in `PendingAcknowledgments.tsx`, and the
   hand-in + payout dialogs in `TuCajaSection.tsx`. Measured at 375px the hand-in paper is 311×436 floating
   mid-screen (top 188, bottom 624) instead of a sheet with a fixed footer — the "reach & repetition" law is
   what the sheet pattern exists to serve. See `screenshots/review-balance-agent-drop-dialog-mobile-375.png`.

8. **Two card idioms on one page.** The three money blocks are `SectionCard` + a 12px uppercase overline;
   Gastos and Entregas are `Card variant="outlined"` + `CardContent` + a 20px `h6` title. Same page, same
   role, two visual grammars for "a card with a title". *Fix: `SectionCard` everywhere, one title treatment.*

9. **The single teal accent leads to a dead end at $0.00.** The admin's Mi caja shows `$0.00` and a
   full-width enabled "Entregar efectivo". Opening it: helper reads *"Disponible para entregar: $0.00"*,
   and **both** "Todo" and "Entregar" are `disabled`. The seller's page has the same hole at zero balance.
   See `screenshots/review-cash-admin-micaja-mobile-375.png` + `review-cash-admin-drop-zero-mobile-375.png`.
   *Fix: disable the CTA when `available <= 0`, or swap it for the "nada por entregar" resting state.*

10. **Sub-minimum touch targets.** Both "Eliminar gasto" icon buttons measure **30×30 px** at 375px width
    (the only controls on the page under 48). `DESIGN_TOKENS.md`: touch targets ≥48px, one-handed field use.

11. **The expense form uses `size="small"` inputs**, below the 48px control min-height the token set pins for
    every other input in the product — and it is the one form a seller fills standing up, outdoors.

12. **One drop's state is split across two contradictory chips.** The admin's direct collection renders
    `Por firmar` (amber, outlined) beside `Confirmado` (green, filled) on the same row — two pills, two
    visual weights, one object. *Fix: one chip for the drop's lifecycle, the signature obligation expressed
    as the row's own affordance (it already has a dedicated card at the top of the page).*

13. **Nested tab rows on `/cash`.** `Mi caja | Equipo` and then, inside Equipo, `Saldos | Entregas` — two
    stacked tablists in a 375px column. See `screenshots/review-cash-admin-equipo-mobile-375.png`.

## Could Improve

14. **Every label on the page is 12px.** All `overline` and `caption` text measures 12px — including the
    label of the page's headline number. The brief's base is *"16px, deliberately large for outdoor
    legibility"*. Combined with finding 2 (labels at full ink) the result is small **and** loud, which is the
    opposite of the intended quiet-label/loud-number hierarchy.

15. **Zero-value columns for the affiliate.** `Electrónico · 0 / $0.00` and *"De ventas electrónicas $0.00"*
    render for a role that, in the seeded case, only takes cash. Hiding a zero electronic split would let the
    cash figure own the card.

16. **Desktop is one 680px column ~1,900px tall.** Deliberate (mobile-first, `maxWidth: 680`), and the right
    default — but at 1280 the three money cards could pair two-up and halve the scroll without touching the
    mobile layout.

17. **"Cancelar" carries two meanings on the same screen** — cancelling a *hand-in* in the Entregas row, and
    dismissing the *dialog*. The verb glossary (US-UX05) resolved exactly this kind of collision for
    cancel/refund; "Cancelar entrega" would.

18. **`CLAUDE.md` says MUI v6; `package.json` pins `^9.0.1`.** Finding 2 is what stale version documentation
    costs — an upgrade silently changed a prop's contract and nothing in the docs or the tests noticed.

## What Works Well

- **The agent↔affiliate surface split is the pattern working.** One page, one gate
  (`showExpenses={!isAffiliate}`), the reason written at the call site with its decision ID (D4) and the API
  denying it independently. Nothing to unify here — this is what finding 4 should be fixed *into*.
- **`CashBoxCard` gets the signature element right.** 32px/700/tabular, neutral ink for cash owed and error
  red only when the company owes, `srLabel` on the figure, teal reserved for the action below it, and the
  reconciliation folded behind "¿Cómo se calcula?" so the headline reads clean. Textbook against the brief.
- **The signature queue is the correct pattern for an interruption that must not interrupt** — a non-blocking
  `AlertCard` at the top with money-first framing and the countdown stated in words. Measured contrast
  `#92400E` on `#FEF3C7` ≈ **7:1**, comfortably past AA.
- **The Equipo tab is the best-built surface in this area**: `MoneyText` with per-person SR labels, the
  affiliate company chip **icon-paired** (the rule the drop chips break), and per-row actions that name the
  verb ("Registrar cobro directo"). It is proof the primitives are right and the problem is reach, not design.
- **Copy carries real teaching**: *"Lo electrónico no entra a tu caja — lo cobra la empresa"* and *"Las de
  ventas electrónicas reducen tu deuda de efectivo — son ganancia directa"* answer the confusion the cards
  exist to resolve, in the seller's language.
- **Reduced motion is honoured globally** (`tokens.css:101`), and the input focus tint measured exactly
  `rgba(15,118,110,0.08)` — the `--color-focus-tint` token, applied as specified.
