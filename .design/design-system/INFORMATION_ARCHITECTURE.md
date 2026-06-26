# Information Architecture: GuideMe (Whole-Product)

> This is the **product-wide** structural skeleton the design system dresses — not a single
> feature. It consolidates the confirmed App-Shell redesign (`docs/navigation/app-shell-redesign.spec.md`,
> decisions D1–D9), the live route table (`app-guideme/src/config/routes.ts`), and all four roles
> from `docs/SPEC.md`. The design system inherits this structure; it does not change it. Where the
> shell and the routes disagree (shared *labels* over original *paths*), that's the intentional
> Phase-1 decision **D6** (rename labels, keep routes) — documented here, not "fixed."

## Site Map

URLs are the **live routes** from `config/routes.ts`. Nav **labels** follow the shared vocabulary
(D1); the two intentionally differ until the Phase-3 page-merge cleanup.

### Unauthenticated (AuthLayout)
- Login `/login`
- Register (admin creates org) `/register`
- Verify email `/verify`
- Forgot password `/forgot-password`
- Reset password `/reset-password`
- Accept invitation (agent / affiliate) `/invite/accept`

### Agent (AppLayout — BottomNav: Vender · Escáner · Ventas · Caja)
- **Vender** `/pos` *(landing — D2)*
  - Service detail / Bottom Sheet `/pos/service/:id`
  - Checkout `/pos/checkout`
  - Folio result `/pos/folio/:id`
- **Escáner** `/scan`
- **Ventas** (own folio history) `/history` → detail `/history/:id`
- **Caja** (own running balance, expenses, hand-ins) `/balance`

### Admin (AppLayout — BottomNav: Vender · Escáner · Ventas · Caja · Hoy; Gestión in account surface)
- **Hoy** `/dashboard` *(landing — D2; interim queue cards now, Daily Ops Dashboard later)*
- **Vender** `/pos` *(+ /pos/service/:id, /pos/checkout, /pos/folio/:id)* — admin is a first-class seller
- **Escáner** `/scan`
- **Ventas** (org-wide folios) `/folios` → detail `/folios/:id`
- **Caja** (Tu caja + team review queue) `/cash` → drop detail `/cash/drops/:id`
- **Gestión** *(account surface / overflow — D5)*
  - Agentes `/agents` → invite `/agents/invite`
  - Afiliados `/affiliates` → detail/edit `/affiliates/:id`
  - Catálogo `/catalog` → detail `/catalog/:id`
  - Reportes `/reports`
  - Configuración `/settings`

### Affiliate (AppLayout — reduced: Vender · Ventas · Caja; **no Escáner, no expenses**)
- **Vender** `/pos` *(landing; curated catalog only — US-A56 allow-list)* + service/checkout/folio sub-routes
- **Ventas** (own folios) `/history` → `/history/:id`
- **Caja** (own balance + deposit/cash-drop, **no expense action**) `/balance`

### Tourist Portal (Phase 2 — standalone tokenized surface, magic-link, no app shell)
- Portal home (itinerary) — token URL
- QR tickets / download
- Cancellation request → Refund PIN

## Navigation Model

- **Primary navigation** — concept-named, shared across roles (**Vender · Escáner · Ventas · Caja ·
  Hoy**, D1). Capped at 5 items.
  - **Mobile:** fixed bottom bar (`BottomNav`), thumb-reachable. The system's primary-action button
    is *also* bottom-anchored, so the bottom zone is the action zone (brief principle 3).
  - **Desktop:** full-height left **rail** — monogram top · destination pills · bottom-pinned avatar
    popover. The rail is a pure mirror of the mobile bar (admin nav = agent nav + Hoy).
- **Secondary navigation** — within-screen, vertically stacked sections (no deep tabs). Examples:
  Caja's *Tu caja* / *Equipo*; a folio detail's services + audit timeline; the service-creation
  Wizard's stepper.
- **Utility navigation (account surface, D3/D4)** — replaces the removed top bar. Desktop = bottom
  avatar popover; mobile = fixed top-right avatar chip → bottom sheet. Both hold the same content:
  identity header · admin **Gestión** group · Configuración · **Cerrar sesión**.
- **Badges (D8)** — meaning is consistent: a Caja badge = "money needs your attention" (admin: count
  of pending agent/affiliate drops; agent/affiliate: pending signature). Ventas may badge pending
  cancellations. Badges use the **amber/red functional** colors, never teal.
- **No top app bar.** Content uses the full viewport (US-UX03).

## Content Hierarchy

The design system recurs through a few **screen archetypes**. Defining the hierarchy once keeps
every feature consistent. The signature rule everywhere: **the money/count reads first.**

### Transactional screen (POS checkout, Caja)
1. **Alert / action card** (if any) — sign/dispute, pending drop, slot warning. Top, impossible to
   miss, amber/red semantics.
2. **The dominant figure** — total to charge / balance to hand in / spots remaining. Large tabular
   Manrope (`MoneyText`).
3. **The supporting math** — sales − commission − expenses = net; line items. Secondary text.
4. **Primary action** — single teal, full-width, bottom-anchored button (Cobrar / Entregar / Liquidar).
5. **Secondary/contextual** — history snapshot, notes.

### Catalog / list screen (POS catalog, Ventas, Agentes, Afiliados, Catálogo)
1. **Filters** — date strip + category chips + "Ocultar agotados" (POS); status/date (lists). Top,
   sticky.
2. **The list** — cards/rows; each leads with its identifying figure (price, amount, balance).
3. **Empty state** — quiet, typographic, consistent voice ("Aún no hay…").
4. **FAB / primary create** — teal (e.g., Nuevo servicio, Nuevo afiliado).

### Dashboard ("Hoy")
1. **Pending-action queue** (interim) / **occupancy at a glance** (Phase 2) — what needs attention.
2. **Day's sales summary** — total collected, folios, per-seller.
3. **Drill-in links** to Ventas / Caja.

### Detail screen (folio, affiliate, service, drop)
1. **Identity + status** — who/what + a `StatusChip` (functional color).
2. **Core figures** — amounts, dates, spots.
3. **Line items / breakdown.**
4. **Audit timeline** (folio) — who/when/why.
5. **Actions** — one verb each (Cancelar folio, Confirmar, Liquidar).

### Wizard / multi-step (Service Creation, Affiliate Setup)
1. **Fixed header** — title · close X · "PASO n DE N" · progress bar.
2. **Step body** — one decision cluster, never the whole form.
3. **Fixed footer** — Anterior / Siguiente (→ Finalizar/Guardar), Anterior disabled on step 1.

## User Flows

### Daily loop — Agent (the 80% path)
1. Opens app → lands on **Vender** `/pos` (D2).
2. Catalog defaults to **Hoy**, sold-out hidden, category chips. Taps a service.
3. **Bottom Sheet** slides up: party size first → reactive slot matrix → price/extras.
4. *Agregar al carrito* → sheet auto-closes, Snackbar "Ver carrito".
5. Checkout: amount pre-loaded to total.
   - Amount = total → **Finalizar Pago** → `paid`, QR + email.
   - min ≤ amount < total → **Registrar Reserva** → `booking`, deposit, no QR yet.
6. Later: customer presents QR → **Escáner** `/scan` → ✓ Valid (pass n of m) / ✗ Invalid.
7. End of route: **Caja** `/balance` → review debt → **Entregar efectivo** (cash drop).

### Settle loop — Admin
1. Caja badge shows pending drops → opens **Caja** `/cash`.
2. **Tu caja** (own drawer, self-authorized) pinned above **Equipo**.
3. Taps an agent/affiliate with a pending drop → drop detail `/cash/drops/:id`.
4. **Confirmar recepción** (accept) or **Adjust** (new amount + mandatory note).
   - Adjust → agent gets an Alert card → **Firmar** or **Disputar**.

### Setup flow — Admin onboards an affiliate
1. Gestión → Afiliados → **Nuevo afiliado** (Wizard).
2. Step 1 Company → Step 2 curated catalog + per-service commission → Step 3 invite emails.
3. **Finalizar** → company + commissions saved, magic-link invites sent.
4. Affiliate accepts `/invite/accept` → lands on **own POS** (curated catalog only).

## Naming Conventions

Pick one word, use it everywhere (D1 vocabulary + D7 verbs). The system enforces this in component
labels.

| Concept | Label in UI | Notes |
|---------|-------------|-------|
| Sell destination | **Vender** | `/pos`. Same for agent, admin, affiliate. |
| Scan destination | **Escáner** | `/scan`. Agent + admin only (affiliate has none). |
| Sales list | **Ventas** | Replaces split "Folios"/"Historial". |
| Cash drawer | **Caja** | Replaces split "Cash"/"Balance". |
| Admin home | **Hoy** | `/dashboard`. |
| Take payment | **Cobrar** | The POS checkout verb. |
| Settle a booking | **Liquidar saldo** | Collect the remaining balance → `paid`. |
| Hand cash in | **Entregar efectivo** | Never "Corte"/"Cierre". |
| Admin accepts a drop | **Confirmar recepción** | After counting bills. |
| Agent acknowledges | **Firmar** / **Disputar** | Audit-grade; not "Aceptar". |
| Cancel a sale | **Cancelar folio** | Bare "Cancelar" reserved for dismissing dialogs. |
| Running balance | **Efectivo a entregar** / **Tu deuda** | Company cash the seller holds. |
| Management group | **Gestión** | Account-surface overflow (admin). |

## Component Reuse Map

The structural/layout backbone the design system standardizes (the brief's shared primitive layer).

| Component | Used on | Behavior differences |
|-----------|---------|---------------------|
| `AppLayout` (shell) | All authenticated screens | Agent/affiliate = bottom bar; admin = + Hoy; desktop = rail. Affiliate hides Escáner. |
| `AuthLayout` | Login/register/verify/reset/invite | Centered, no nav, full-bleed brand. |
| `BottomNav` / rail | All authenticated | Role-scoped item set; badges on Caja/Ventas. |
| Account surface (avatar popover / chip+sheet) | All authenticated | Desktop popover vs mobile chip→sheet; same content. |
| `BottomSheet` *(→ promote to shared layer)* | POS, Caja, date filter, wizards | Sales config vs expense/drop vs calendar; the canonical overlay (uses real shadow). |
| `SectionCard` (surface container) | Everywhere | Hairline border, 16px, 24px pad, no resting shadow. |
| `MoneyText` (numeric) | Caja, POS, reports, folios | Color by semantics (neutral/green/red), not by brand. |
| `AlertCard` | Caja (both), Hoy | Amber/red; blocks attention until resolved. |
| `StatusChip` | Folios, drops, bookings | Functional color + label word; never teal. |
| `Wizard` shell (header/stepper/footer) | Service Creation, Affiliate Setup | Same chrome, different steps. |
| FAB / primary CTA | POS, catalog, lists | Single teal action per screen; bottom-anchored. |

## Content Growth Plan

- **Accumulating** — Ventas (folios), Caja drops, Agentes, Afiliados, Catálogo, Reportes. These grow
  unbounded → the system standardizes **filter-first list screens** (date range, status, category,
  "ocultar agotados") with pagination/infinite-scroll, a consistent empty state, and a search affordance
  where the set can get large (Catálogo, Afiliados).
- **Fixed** — Vender (catalog scoped to availability windows), Escáner, Hoy, Configuración, auth.
- **Reports** grow by period, not by rowcount on screen → date-range scoping + CSV/PDF export keeps the
  view bounded.

## URL Strategy

- **Pattern:** `/<section>` for daily destinations; `/<section>/:id` for details; `/<section>/<action>`
  for sub-pages (e.g. `/agents/invite`, `/pos/checkout`).
- **Dynamic segments:** `:id` for folio/service/affiliate/drop/history detail.
- **Overlays via query/local state:** bottom sheets and modals set state (or `?action=drop` /
  `?action=expense`) so mobile **Back** dismisses the sheet rather than leaving the screen —
  important for one-handed flow.
- **Role scoping is server-side**, not URL-encoded: `/pos`, `/history`, `/balance` are shared paths
  whose data is caller-scoped (agent vs affiliate vs admin); cross-scope access → `404`.
- **Phase-1 stability (D6):** routes are *not* renamed to match labels. The Phase-3 cleanup that
  merges duplicate page pairs (`/folios`↔`/history`, `/cash`↔`/balance`) into role-aware components
  is the only planned URL churn — out of scope for the design system.
