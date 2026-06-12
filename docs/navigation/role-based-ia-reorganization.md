# Plan: Role-Based IA Reorganization — navigation & access aligned to each role's workflow

> Status: **draft for review** — defaults are chosen throughout; override any of the
> Open Questions (§6) and the plan adjusts. No code has been changed yet.

## 1. Context — what each role actually does

**Admin, daily:** sell services (cart → checkout → folio), grant access via QR scan,
approve tourists' cancellation requests, and at end of day review agents' sales and
collect cash. **Occasionally:** add services/schedules, invite agents, change org
configuration (e.g. the acknowledgment window, US-A29).

**Agent, daily:** sell services, scan tourists' QR codes, and at end of day check the
balance — total sold, commission owed, cash to hand in.

## 2. Gaps between those workflows and the current app

| # | Gap | Evidence |
|---|---|---|
| G1 | **Admins cannot sell.** POS is agent-only in the UI (`RoleGuard role="agent"` on `/pos/*` in `App.tsx`) *and* the API (`requireRole('agent')` in `routes/pos/index.ts`). Selling is the admin's primary daily activity. | `app-guideme/src/App.tsx:89-120`, `api-guideme/src/routes/pos/index.ts:29` |
| G2 | **Admins cannot scan.** Same double gate on the scanner (`/scan` route + `routes/tickets/index.ts:23`). | `App.tsx:141-148`, `tickets/index.ts:23` |
| G3 | **Both roles land on a stub.** `/dashboard` is the default destination and the logo link, but `DashboardPage` is a placeholder ("se ampliará en futuras versiones"). The agent's first daily action (sell) and the admin's (sell / review) are each one extra tap away, every time. | `pages/DashboardPage.tsx` |
| G4 | **Admin nav has no frequency hierarchy.** Daily tools (Folios, Cash) and occasional tools (Agentes, Catálogo) share the bar with equal weight; there is no home for org configuration or future reports at all. | `layout/AppLayout.tsx:42-52` |
| G5 | **The Caja queue has no badge.** Pending cash drops awaiting admin confirmation aren't surfaced on the nav item (only Folios↔cancellations and Balance↔acks have badges). | `AppLayout.tsx:80-84` |

## 3. Proposed information architecture

Principles: **the nav bar holds the daily loop; everything occasional moves to an
overflow menu. Destinations are named after the *concept*, not the role's view of
it** — so both roles share one vocabulary and the same label always means the same
thing, just scoped by role. Both roles land directly on their first daily action.

Today the navs use four labels for two concepts: admin **Folios** and agent
**Historial** are both *the list of sales* (org-wide + manageable vs own + read-only);
admin **Cash** and agent **Balance** are both *the cash drawer* (everyone's drawers +
drop queue vs my drawer + hand-ins). Unifying them:

### Shared vocabulary

| Concept | Label | Agent sees | Admin sees |
|---|---|---|---|
| Make a sale | **Vender** | POS flow | same POS flow (G1 unlock) |
| Grant access | **Escáner** | QR scanner | same scanner (G2 unlock) |
| The record of sales | **Ventas** | own folios, read-only (today `/history`) | all org folios + cancellation actions (today `/folios`), cancellation badge |
| The cash drawer | **Caja** | own balance, hand-ins, acks (today `/balance`), ack badge | **Tu caja** (own drawer + Entregar, self-confirmed) on top, then **Equipo** — all agents' balances + drop queue (today `/cash`), drops badge |
| The operating day | **Hoy** | — (folds into Caja / US-AG26, Q3) | occupancy + day's sales + pending queues |

A nice property falls out: **the admin nav is exactly the agent nav plus "Hoy" and
the overflow menu.** Same labels, same icons, same positions — an admin who trains an
agent points at the same buttons, and the badge on Caja means "money needs your
signature/confirmation" for both roles.

### Agent — 4 destinations (was 5)

| Slot | Destination | Notes |
|---|---|---|
| 1 | **Vender** (`/pos`) | New default landing — replaces the stub Dashboard. |
| 2 | **Escáner** (`/scan`) | unchanged |
| 3 | **Ventas** (`/history`) | renamed from "Historial" |
| 4 | **Caja** (`/balance`) | renamed from "Balance"; end-of-day hub; ack badge stays. The future US-AG26 daily snapshot (`GET /api/dashboard/me`) lands here, not on a separate dashboard (Q3). |

The Dashboard destination disappears for agents. Logo link → `/pos`.

### Admin — 5 destinations + overflow menu

| Slot | Destination | Notes |
|---|---|---|
| 1 | **Hoy** (`/dashboard`) | Default landing. Phase 2 fills it with the already-spec'd **Daily Operations Dashboard** (`docs/dashboard/occupancy-dashboard.spec.md`: occupancy US-A14/A15, day's sales US-A16). Phase 1 ships an interim version: pending-queues cards (cancellations, drops) that deep-link to Ventas/Caja. |
| 2 | **Vender** (`/pos`) | Unlocked for admins (G1). Same POS flow, same screens. |
| 3 | **Escáner** (`/scan`) | Unlocked for admins (G2). |
| 4 | **Ventas** (`/folios`) | renamed from "Folios"; cancellation-request badge stays. "Folio" remains the domain word for an individual receipt — only the destination label changes. |
| 5 | **Caja** (`/cash`) | renamed from "Cash". Two stacked sections (resolved Q2): **Tu caja** — the admin's own drawer (collected · commission · net + an *Entregar* action that records a self-confirmed drop, §4 API rule 3) — pinned above **Equipo**, the agents' balances and pending-drop review queue. Pending-drops badge (G5) counts only *agent* drops, since the admin's never go pending. |
| ⋮ | **Cuenta (avatar)** | Agentes, Catálogo, future Configuración (US-A29) and Reportes (US-A17/A18/A20), and Cerrar sesión — see *App chrome* below. |

Mobile bottom bar caps at 5 items, which the daily set exactly fills.

### App chrome — no top bar

The top app bar (logo, user name, logout) is **removed**; content gets the full
viewport. Everything it held moves into a single **account surface**, which also
absorbs the admin overflow menu:

- **Desktop:** the rail becomes full-height. Top: a small GuideMe monogram (links to
  the role's landing). Middle: the destination pills; for admins, a thin divider and
  a second **Gestión** group (Agentes, Catálogo — shown inline, since the rail has
  room). Pinned at the **bottom of the rail**: an avatar button (initials) opening a
  popover — identity header (name · role · organization), Configuración, **Cerrar
  sesión**.
- **Mobile:** the bottom bar is unchanged (4 agent / 5 admin). A small **avatar chip
  fixed at the top-right** of the viewport (rendered by the layout, safe-area aware,
  subtle frosted backdrop so it reads above any content) opens a **bottom sheet**:
  identity header, Gestión links (admin only), Configuración, **Cerrar sesión**.

Page titles stay left-aligned, so the chip never collides with them; it is the only
fixed overlay. Logout sits behind exactly one tap-plus-confirm on both form factors,
out of the way of the daily loop but always in the same corner.

**Vender vs Ventas:** the two labels are deliberately related (action vs record) but
visually close in a bottom bar. Distinct icons (POS terminal vs receipt list) and
fixed positions mitigate it; if it still reads ambiguous in practice, the fallback is
keeping "Historial" for the list on both roles (Q6).

### Beyond the nav — one verb per action, everywhere

The same unification applies to in-screen CTAs: each domain action gets exactly one
verb, reused on every screen and confirmation dialog that performs it —
**Cobrar** (take payment at checkout), **Entregar** (agent hands cash in),
**Confirmar** (admin accepts a drop/collection), **Firmar / Disputar** (agent
acknowledges a money move), **Cancelar folio** (never just "Cancelar", which is
reserved for dismissing dialogs). Phase 1 includes a sweep of existing buttons
against this glossary.

## 4. Changes required

### API (`api-guideme`)

1. **`requireRole` accepts multiple roles** — extend `middleware/role.ts` to
   `requireRole(...roles)`; apply `requireRole('agent', 'admin')` to `routes/pos` and
   `routes/tickets`.
2. **Commission for admin sellers — identical to agents (no special case).** When
   the admin sells, the POS handler runs the *exact same* code path: their own
   `users.baseCommission` (editable in Configuración) plus per-service bonus
   (US-A12), snapshotted on the folio. No `role` branch, no setting. The admin
   simply appears in the commission report (US-A17) as another seller. (Resolved Q1
   — "earn like everyone else.")
3. **The self-authorization rule for the admin's own cash** — the elegant core of
   this change. A settlement event normally needs *two parties*: an agent **hands
   in** and an admin **confirms** (drop `pending → confirmed`, US-A19); or an admin
   **initiates** and the agent **signs** (the acknowledgment window, US-A27/A28).
   When the seller **is** the admin, both parties are the same person, so the event
   is **self-authorized**: it is born `confirmed`, never enters the pending review
   queue, and carries no acknowledgment window. This collapses three flows at once:
   - **Cash drop (hand-in)** — the admin's own drop is created with
     `status='confirmed'`, `reviewed_by = self`, instead of `'pending'`.
   - **Payout when the balance is negative** (US-A25) — also born `confirmed`,
     `reviewed_by = self` (resolved Q9 — symmetric with agents).
   - **Acknowledgment** — N/A; there is no counterparty to sign.

   **Accounting is provably unaffected** because the balance formula is unchanged —
   `collected − commissions − expenses − confirmed_drops + confirmed_payouts` — and
   only sums `confirmed` events. The admin's events are confirmed from birth, so
   they enter the formula identically; the shift-scoped breakdown (US-A19) still
   anchors on "most recent confirmed drop." The *only* thing skipped is the approval
   *step*. Implementation: a single seam in the drop/payout creation handler —
   `if (caller.role === 'admin' && target === caller.userId) status = 'confirmed'`
   — plus an audit marker so a reviewer can tell a self-confirmed event from an
   agent hand-in that an admin later confirmed (`reviewed_by === agent_id` already
   encodes this; surface it as an "auto-confirmada" label).
4. **Cash attribution** — folios keep `agentId = seller.userId` uniformly, so the
   admin's sales roll up to the admin's own drawer (the "Tu caja" section, §3 UI).
5. **Tests** — per `CLAUDE.md`, the widened routes re-run cross-org isolation tests
   with `seedTwoOrgs`, plus new cases: admin sale → commission computed by the agent
   formula and visible in the report; admin folio visible in Ventas; admin drop
   born `confirmed` and **absent** from the pending queue; admin self-payout zeroes a
   negative balance; an agent's drop still requires explicit admin confirmation
   (self-authorization must not leak to agents).

### Frontend (`app-guideme`)

1. **`AppLayout`** — remove the top `AppBar`; full-height rail with monogram,
   destination pills, admin Gestión group, and a bottom-pinned avatar popover
   (desktop); fixed top-right avatar chip opening an account bottom sheet (mobile);
   role-aware nav sets per §3; pending-drops badge on Caja. Logout moves into the
   account popover/sheet with a confirm step.
2. **Routing** — drop `RoleGuard role="agent"` from `/pos/*`, `/scan`; root/logo and
   post-login redirect by role (`agent → /pos`, `admin → /dashboard`); keep
   `/history` & `/balance` agent-only and `/folios`, `/cash`, `/agents`, `/catalog`
   admin-only.
3. **Interim "Hoy" page** — replace the stub for admins with queue cards
   (cancellations pending, drops pending) + links; agents no longer route here.
4. **POS receipt route** (`/pos/folio/:id`) — unlock for admin (it is part of the
   sale flow).
5. **Label sweep** — apply the shared vocabulary (§3) to nav items, page titles, and
   CTAs. Phase 1 changes labels only; routes (`/history`, `/folios`, `/balance`,
   `/cash`) and page components stay as they are.
6. **Screen unification (later cleanup, not Phase 1)** — once labels converge, the
   duplicate page pairs can merge into single role-aware components:
   `FoliosListPage` + `FolioHistoryPage` → one Ventas list (role decides the API
   source and whether management actions render), and `FolioDetailPage` +
   `FolioHistoryDetailPage` → one folio detail with action gating. Halves the
   surface that has to stay visually in sync.

## 5. Phasing

- **Phase 1 — unlock & reorganize (small, immediate value):** API role widening,
  admin commission via the agent formula, the self-authorization rule for the
  admin's own drops/payouts (§4 rule 3), top-bar removal + account surface (rail
  avatar popover / mobile avatar chip + sheet), nav restructure with the shared
  vocabulary, label/CTA sweep, role-based landing, interim Hoy, Tu caja section +
  Caja badge.
- **Phase 2 — Daily Operations Dashboard:** implement
  `docs/dashboard/occupancy-dashboard.spec.md` as the real "Hoy"; fold the US-AG26
  agent snapshot into the agent's Caja.
- **Phase 3 — overflow grows + screen unification:** Configuración home (ack
  window), Reportes (US-A17/A18/A20, export US-A20); merge the duplicate
  list/detail page pairs into role-aware components (§4 frontend item 6).

## 6. Open questions (defaults in bold — answer only to override)

- **Q1 — Admin commission on own sales:** **resolved — identical to agents**, same
  formula, no setting, no role branch (§4 API rule 2). Admin appears in the
  commission report as a seller.
- **Q2 — Admin's Caja layout:** **resolved — "Tu caja" section on top, "Equipo"
  (agent balances + drop queue) below** (§3 admin Caja row).
- **Q3 — Agent landing & US-AG26:** **agents land on Vender (POS); the daily
  snapshot goes to the top of the agent's Caja**. Alternative: keep a slim agent
  dashboard as landing.
- **Q4 — Admin scanner placement:** **in the bottom bar** (stated as a likely daily
  need). Alternative: move to overflow to free a slot for Agentes.
- **Q5 — Labels (UI is Spanish):** **resolved — shared vocabulary per §3: Vender,
  Escáner, Ventas, Caja, Hoy** (one label per concept, both roles).
- **Q6 — "Ventas" vs "Historial" for the sales list:** **Ventas** (pairs with the
  day-end question "¿cuánto se vendió?" and with Hoy's sales summary). Fallback if
  Vender/Ventas prove too similar in the bottom bar: "Historial" on both roles.
- **Q7 — "Remove the navigation bar" interpretation:** **assumed to mean the top
  app bar** (the header holding logo + logout), since logout is what needed a new
  home; the bottom bar / rail remains the primary navigation. If the bottom bar
  should go too, the design changes to a drawer/gesture model — say so.
- **Q8 — Mobile account affordance:** **resolved — fixed top-right avatar chip +
  bottom sheet** (§3 App chrome).
- **Q9 — Admin negative balance:** **resolved — self-confirmed Payout** (US-A25),
  born `confirmed`, symmetric with agents (§4 API rule 3).
- **Q10 — Multi-admin (future):** not applicable today — invites only create
  `agent` roles, so an org has exactly one admin and self-authorization is
  unconditional. **If** a second admin is ever introduced, revisit whether one
  admin's settlement should require another's confirmation (separation of duties);
  the self-authorization seam (§4 rule 3) is the single place that would gate.
