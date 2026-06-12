# Feature: App Shell Redesign — role-aligned navigation, shared vocabulary & account surface

**User stories:** US-UX01, US-UX02, US-UX03, US-UX04, US-UX05, US-UX06 (platform)
**Phase:** Reorg · Phase 1 (Unlock & Reorganize) · **Depends on:** the IA plan
`docs/navigation/role-based-ia-reorganization.md` (rationale and gap analysis). Pairs with
**Administrator Vendor Capabilities** (`docs/admin-vendor/admin-vendor-capabilities.spec.md`) —
that feature unlocks selling/scanning and owns the **Tu caja** block; this feature owns the
shell those destinations live in.

> Rebuilds the authenticated shell around each role's **daily loop**: both roles land on their
> first daily action, the nav holds only daily destinations named by **concept** (one
> vocabulary for both roles), occasional tools move to an **account surface** that also
> replaces the removed top bar, and in-screen CTAs collapse to **one verb per action**. No
> business logic changes — this is an **information-architecture and presentation** feature.

---

## Context

The shell contradicts both roles' stated workflow (full analysis: the IA plan, §2):

- **G1/G2 — admins can't sell or scan** → owned by the Admin Vendor feature; this feature
  assumes those gates are lifted and gives the unlocked destinations a home.
- **G3 — both roles land on a stub.** `/dashboard` is the default and the logo link, but
  `DashboardPage` is a placeholder. The agent's first daily action (sell) and the admin's
  (review / sell) are each one extra tap away, every session.
- **G4 — admin nav has no frequency hierarchy.** Daily tools (Folios, Cash) and occasional
  tools (Agentes, Catálogo) share the bar with equal weight; org configuration and future
  reports have no home at all.
- **G5 — the Caja queue has no badge.** Pending cash drops awaiting admin confirmation aren't
  surfaced on the nav item (only Folios↔cancellations and Balance↔acks have badges).

Plus a **vocabulary** problem: the navs use **four labels for two concepts** — admin **Folios**
and agent **Historial** are both *the list of sales*; admin **Cash** and agent **Balance** are
both *the cash drawer*. An admin training an agent points at differently-named buttons for the
same thing.

### Design decisions (✅ = confirmed with product)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 ✅ | **Naming** | Destinations are named after the **concept**, not the role's view of it — one shared vocabulary: **Vender · Escáner · Ventas · Caja · Hoy**. | The same label means the same thing for both roles, scoped by role. The admin nav becomes *exactly* the agent nav **+ Hoy + the account menu*. |
| D2 ✅ | **Landing** | Both roles land on their **first daily action**: agent → **Vender** (`/pos`), admin → **Hoy** (`/dashboard`). The stub Dashboard disappears for agents; the logo/monogram links to the role's landing. | Removes a per-session tap; the placeholder is no longer anyone's home. |
| D3 ✅ | **Remove the top bar** | Delete the top `AppBar` (logo + user name + logout); content gets the full viewport. Everything it held moves into a single **account surface**. | "Remove the navigation bar" = the header that held logout (Q7); the bottom bar / rail stays the primary nav. |
| D4 ✅ | **Account surface** | **Desktop:** full-height rail — monogram (top) · daily destination pills · a **bottom-pinned avatar popover**. **Mobile:** unchanged bottom bar + a **fixed top-right avatar chip** opening a **bottom sheet**. The popover/sheet hold the **same** content: identity header · admin **Gestión** group (Agentes, Catálogo) · Configuración · Cerrar sesión. *(Implementation note: Gestión lives in the account surface on **both** form factors rather than inline on the desktop rail — this keeps the rail a pure mirror of the mobile bottom bar, so "admin nav = agent nav + Hoy" holds exactly, and best satisfies US-UX04's "occasional tools out of the daily nav".)* | Logout lives in the same corner on both form factors, one tap-plus-confirm, out of the daily loop. |
| D5 ✅ | **Overflow** | Occasional admin tools — **Agentes, Catálogo**, future **Configuración** (US-A29) and **Reportes** (US-A17/18/20) — live in the account surface, not the bottom bar. | Keeps the mobile bar at its 5-item cap filled by the daily set; gives config/reports a home (G4). |
| D6 | **Phase-1 = labels only** | Rename nav items, page titles, and CTAs to the shared vocabulary; **routes and page components are unchanged** (`/history`, `/folios`, `/balance`, `/cash` keep their paths). | De-risks the reorg: zero data/route churn. Merging duplicate page pairs is deferred (Phase 3). |
| D7 | **One verb per action** | Each domain action gets **one** verb reused on every screen and dialog: **Cobrar** (take payment), **Entregar** (hand cash in), **Confirmar** (admin accepts a drop/collection), **Firmar / Disputar** (agent acknowledges), **Cancelar folio** (never bare "Cancelar", reserved for dismissing dialogs). | Removes the synonym drift that makes the same action read differently across screens. |
| D8 ✅ | **Caja badge counts only agent drops (G5)** | The admin Caja badge shows the count of **pending agent drops** (the admin's own drops never go pending — Admin Vendor D3). | The badge means "money needs your confirmation," consistent with the agent Caja badge meaning "money needs your signature." |
| D9 | **Interim Hoy** | Phase 1 ships Hoy as **queue cards** (cancellations pending, drops pending) deep-linking to Ventas/Caja; Phase 2 replaces it with the spec'd Daily Operations Dashboard. | The admin lands somewhere useful now without blocking on the dashboard build. |

### Scope boundary

| Concern | Owner |
|---|---|
| Top-bar removal, rail/bottom-bar restructure, account surface (desktop popover + mobile chip/sheet), shared-vocabulary label sweep, CTA verb sweep, role-based landing, interim Hoy, Caja badge, Configuración entry point | **This feature** |
| Route-guard widening for POS/scanner, admin commission, self-authorized cash, the **Tu caja** block | *Admin Vendor Capabilities* feature |
| The real Hoy content (occupancy US-A14/15, day's sales US-A16, agent snapshot US-AG26) | *Daily Operations Dashboard* (`docs/dashboard/occupancy-dashboard.spec.md`) — Phase 2 |
| Reportes screens (US-A17/18/20) and the Configuración screen body (ack window US-A29) | *Reports* / *Config* features — this feature only adds their **menu entry points** |
| Merging duplicate list/detail page pairs into role-aware components | Phase 3 cleanup (IA plan §4 frontend item 6) |
| Any change to the balance derivation, folio data, or API business logic | **Out of scope** — this is a pure shell/IA feature |

---

## Information Architecture

### Shared vocabulary (D1)

| Concept | Label | Agent sees | Admin sees |
|---|---|---|---|
| Make a sale | **Vender** | POS flow | same POS flow |
| Grant access | **Escáner** | QR scanner | same scanner |
| The record of sales | **Ventas** | own folios, read-only (`/history`) | all org folios + cancellation actions (`/folios`), cancellation badge |
| The cash drawer | **Caja** | own balance, hand-ins, acks (`/balance`), ack badge | **Tu caja** (own drawer + Entregar) over **Equipo** (agents' balances + drop queue, `/cash`), drops badge |
| The operating day | **Hoy** | — | occupancy + day's sales + pending queues (`/dashboard`) |

### Agent — 4 destinations (was 5)

| Slot | Label | Route | Notes |
|---|---|---|---|
| 1 | **Vender** | `/pos` | New default landing — replaces the stub Dashboard. |
| 2 | **Escáner** | `/scan` | unchanged |
| 3 | **Ventas** | `/history` | renamed from "Historial" |
| 4 | **Caja** | `/balance` | renamed from "Balance"; end-of-day hub; ack badge stays. US-AG26 snapshot lands here (Phase 2), not a separate dashboard. |

Dashboard destination disappears for agents; logo/monogram → `/pos`.

### Admin — 5 destinations + account menu

| Slot | Label | Route | Notes |
|---|---|---|---|
| 1 | **Hoy** | `/dashboard` | Default landing. Interim: queue cards (D9). |
| 2 | **Vender** | `/pos` | unlocked by the Admin Vendor feature |
| 3 | **Escáner** | `/scan` | unlocked by the Admin Vendor feature |
| 4 | **Ventas** | `/folios` | renamed from "Folios"; cancellation badge stays. "Folio" stays the domain word for a receipt — only the label changes. |
| 5 | **Caja** | `/cash` | renamed from "Cash"; **Tu caja** (Admin Vendor) over **Equipo**; pending-agent-drops badge (D8). |
| ⋮ | **Cuenta** (avatar) | — | Agentes, Catálogo, Configuración, Reportes, Cerrar sesión (D4/D5). |

Mobile bottom bar caps at 5 items — the daily admin set fills it exactly.

### App chrome (D3/D4)

- **Desktop:** the rail becomes full-height. **Top:** a small GuideMe monogram (→ role
  landing). **Middle:** the daily destination pills. **Bottom-pinned:** an avatar button
  (initials) opening a popover — identity header (name · role · email), the admin **Gestión**
  group (Agentes, Catálogo), Configuración, **Cerrar sesión**.
- **Mobile:** the bottom bar is unchanged (4 agent / 5 admin). A small **avatar chip fixed at
  the top-right** of the viewport (safe-area aware, subtle frosted backdrop) opens a **bottom
  sheet**: identity header, Gestión links (admin only), Configuración, **Cerrar sesión**. Page
  titles stay left-aligned so the chip never collides; it is the only fixed overlay.

Logout sits behind exactly **one tap-plus-confirm** on both form factors, always in the same
corner.

---

## Frontend (app-guideme)

This is a **frontend-only** feature (no API changes). Layered per the frontend rules;
elegant-minimalist (outlined surfaces `elevation={0}` + `1px solid divider`, one accent for
active state, generous spacing).

### `layout/AppLayout.tsx`

- **Remove** the top `AppBar`/`Toolbar` block (logo, `{user.name} ({user.role})`, "Cerrar
  sesión").
- **`NAV_ITEMS`** rebuilt to the shared vocabulary and role sets (D1): Vender/Escáner/Ventas/
  Caja for agents; Hoy/Vender/Escáner/Ventas/Caja for admins. Single source of truth still
  feeds both the rail and the bottom bar.
- **Desktop rail** gains the monogram (top), the admin **Gestión** group (divider + Agentes/
  Catálogo), and a bottom-pinned **avatar popover**.
- **Mobile** gains the fixed top-right **avatar chip** + **bottom sheet**; the bottom bar
  keeps its current behaviour.
- **`badgeFor`** extended: Caja (`/cash`) → **pending agent-drops count** (D8/G5), alongside
  the existing Ventas↔cancellations (admin) and Caja↔acks (agent) badges. A
  `usePendingDropCount(user.role === 'admin')` hook backs it (reads the existing pending rollup
  on `GET /api/cash/balances` — no new endpoint).

### New components

- `layout/AccountMenu.tsx` — role-aware content (identity header · Gestión for admins ·
  Configuración · Cerrar sesión with a confirm step), rendered as a **popover** (desktop) or
  **bottom sheet** (mobile) by `AppLayout`.
- `layout/AccountAvatarChip.tsx` — the fixed mobile top-right affordance.

### Routing (`config/routes.ts`, `App.tsx`)

- **Role-based landing / post-login redirect:** `agent → /pos`, `admin → /dashboard`. Logo/
  monogram links to the same per-role landing.
- Route paths unchanged (D6). `/history` & `/balance` stay agent-only; `/folios`, `/cash`,
  `/agents`, `/catalog` stay admin-only. (POS/scanner guard widening is the Admin Vendor
  feature's, not this one.)

### Label & CTA sweep (D6/D7)

- Nav labels and page `<h1>`/titles → shared vocabulary (Ventas, Caja, Vender, Escáner, Hoy).
- CTA verbs swept against the glossary: **Cobrar · Entregar · Confirmar · Firmar/Disputar ·
  Cancelar folio**; "Cancelar" reserved for dialog dismissal. No behavioural change — text and
  the bound handler stay paired, only the label normalizes.

### Interim Hoy (`pages/DashboardPage.tsx`, admin) (D9)

Replace the stub with two outlined **queue cards** — *Cancelaciones pendientes*
(`usePendingCancellationCount`) and *Entregas por confirmar* (`usePendingDropCount`) — each
deep-linking to Ventas / Caja. Agents no longer route here.

---

## Accessibility & responsiveness

- The mobile avatar chip is keyboard-reachable, has an accessible name (the user's name), and
  its sheet traps focus; `aria-current="page"` stays on the active destination (rail + bar).
- The chip respects `env(safe-area-inset-*)`; the bottom bar keeps its `appBar` z-index and the
  chip sits just above content without overlapping page titles (left-aligned).
- Logout confirm is a standard MUI dialog (Esc dismisses, focus returns to the trigger).

---

## Scenarios

### US-UX01 — Role-based landing (D2)

#### S1 — Agent lands on Vender
**Given** an agent logs in (or opens the app)
**Then** they land on `/pos` (**Vender**); there is no Dashboard destination in their nav; the
monogram links to `/pos`.

#### S2 — Admin lands on Hoy
**Given** an admin logs in
**Then** they land on `/dashboard` (**Hoy**) showing the interim queue cards; the monogram
links to `/dashboard`.

### US-UX02 — Shared vocabulary (D1)

#### S3 — Same labels, both roles
**Then** both navs read **Vender · Escáner · Ventas · Caja** for the shared concepts (admin
adds **Hoy**); "Historial"/"Folios" and "Balance"/"Cash" no longer appear as labels. Routes are
unchanged (D6).

### US-UX03 — No top bar; account surface (D3/D4)

#### S4 — Top bar removed, content full-width
**Then** no top `AppBar` renders; the main content area spans the former header height.

#### S5 — Desktop logout via rail popover
**Given** a desktop viewport
**When** the user opens the bottom-pinned avatar popover and chooses **Cerrar sesión** →
confirm
**Then** the existing `useLogout()` runs; the identity header shows name · role · organization.

#### S6 — Mobile logout via chip + sheet
**Given** a mobile viewport
**Then** a fixed top-right avatar chip opens a bottom sheet containing identity, Configuración,
and **Cerrar sesión** (with confirm); for admins the sheet also lists **Gestión** (Agentes,
Catálogo). The chip never overlaps the left-aligned page title.

### US-UX04 — Overflow holds occasional tools (D5)

#### S7 — Admin management tools out of the daily bar
**Then** the admin bottom bar shows only the 5 daily destinations; Agentes, Catálogo,
Configuración, and Reportes are reachable only through the account surface (avatar popover on
desktop, bottom sheet on mobile).

### US-UX05 — One verb per action (D7)

#### S8 — CTA glossary applied
**Then** taking payment reads **Cobrar** everywhere; handing cash in reads **Entregar**; an
admin accepting a drop reads **Confirmar**; an agent acknowledging reads **Firmar** / **Disputar**;
cancelling a sale reads **Cancelar folio** — and bare "Cancelar" appears only on dialog-dismiss
buttons. No handler/behaviour changes.

### US-UX06 — Caja badge (D8/G5)

#### S9 — Admin Caja shows pending agent drops
**Given** 2 agent drops awaiting confirmation
**Then** the admin Caja nav item shows a badge of **2**; confirming one drops it to **1**; the
admin's **own** (self-confirmed) drops never increment it.

### Regression / non-functional

#### S10 — Badges intact
**Then** the agent Caja ack badge and the admin Ventas cancellation badge still render with
their existing counts and queries.

#### S11 — Role isolation in nav
**Then** an agent never sees admin destinations or the Gestión group, and vice-versa; deep-
linking to a cross-role route still bounces via the existing role guards.

---

## Definition of Done

**Frontend**
- [x] Top `AppBar` removed; full-height rail with monogram, role-aware destination pills,
      bottom-pinned avatar popover (desktop; Gestión lives inside the popover per D4's
      implementation note).
- [x] Fixed top-right avatar chip + account bottom sheet (mobile); logout moved there behind a
      confirm step; identity header shows name · role · email.
- [x] `NAV_ITEMS` rebuilt to the shared vocabulary and role sets; labels/page titles swept;
      CTA verb glossary applied (D6/D7) — checkout CTA normalized "Confirmar venta" →
      **Cobrar**, agent acknowledgment "Firmar / Confirmar" → **Firmar** (Confirmar stays
      admin-only); all other surfaces were already conformant (Entregar, Confirmar recibo,
      Disputar, Cancelar folio; bare "Cancelar" only on dialog dismissals).
- [x] Role-based landing + monogram link (`agent → /pos`, `admin → /dashboard`); stub Dashboard
      no longer an agent destination; `RoleGuard` fallback made role-aware to avoid loops.
- [x] Interim Hoy queue cards (cancellations, drops) deep-linking to Ventas/Caja.
- [x] Caja pending-agent-drops badge (`usePendingDropCount`, reuses `GET /api/cash/balances`);
      existing ack/cancellation badges intact.
- [x] Account menu exposes entry points for Agentes, Catálogo, and Configuración (disabled
      "Próximamente"); Reportes entry lands with the Reports feature.
- [x] Mobile chip is safe-area aware, keyboard-accessible, never overlaps page titles.
- [x] `pnpm lint:app`, `tsc`, `pnpm build:app` clean.

**Backend**
- [x] **None** — no API changes (the pending-drops count reads the existing rollup).

**Docs**
- [x] `docs/SPEC.md` carries US-UX01–UX06 and the reorg feature line linking this spec.

---

## Resolved questions

Confirmed with product (2026-06-11) — see the IA plan §6 for the full set:

1. **D1/D3/D4 ✅** Shared vocabulary; remove the **top** bar; avatar popover (desktop) + chip/
   sheet (mobile).
2. **D2 ✅** Agent lands on Vender; admin on Hoy. US-AG26 snapshot folds into the agent's Caja.
3. **D6 ✅** Phase 1 changes labels only; routes/components unchanged (page-pair merge is Phase 3).
4. **D8 ✅** The admin Caja badge counts only **agent** drops.
5. **Q6** "Ventas" chosen over "Historial"; fallback to "Historial" on both roles only if
   Vender/Ventas prove too similar in the bottom bar.
