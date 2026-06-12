# Feature: Administrator Vendor Capabilities

**User stories:** US-A31, US-A32, US-A33, US-A34, US-A35 (admin)
**Phase:** Reorg · Phase 1 (Unlock & Reorganize) · **Depends on:**
Mobile POS (`docs/pos/pos-controlled-discount.spec.md`), Online QR Scanner
(`docs/scanner/online-qr-scanner.spec.md`), Commissions (`docs/commissions/commissions.spec.md`),
Agent Continuous Cash Balance (`docs/cash-drops/agent-balance-cash-drops.spec.md`) and Advanced
Cash Collection (`docs/cash-drops/advanced-cash-collection.spec.md`) — this feature widens those
flows to the admin role; read them first. Companion to the IA plan
`docs/navigation/role-based-ia-reorganization.md`.

> Unlocks the **admin as a first-class seller**: the same POS flow, the same QR scanner, the
> same commission math agents already use, with **one** asymmetry that reflects the admin's
> elevated permissions — the admin's own cash hand-ins and payouts are **self-authorized**
> (born `confirmed`, no approval queue, no acknowledgment window). The feature is
> **financially inert**: the running-balance derivation and the balance invariant are
> untouched; the admin simply becomes another seller whose settlement events skip the
> approval *step* (not the accounting).

---

## Context

Selling is the admin's **primary daily activity** (sell, validate the cart, generate the
sale, grant access by scanning), yet the app blocks it twice over:

- **POS is agent-only** — `pos.use('*', authMiddleware, requireRole('agent'))`
  (`routes/pos/index.ts:29`) on the API, and `RoleGuard role="agent"` on `/pos/*` in
  `App.tsx` on the client.
- **The scanner is agent-only** — the identical double gate
  (`routes/tickets/index.ts:23` + `RoleGuard` on `/scan`).

So today an admin who wants to make a sale or admit a guest has no path to it. This feature
removes both gates and answers the three questions that fall out of letting an admin sell:
*Do they earn commission? How does the cash they collect settle? Where do they see it?*

The answers (resolved with product — see *Resolved questions*): **commission, identical to an
agent's**; **settlement, self-authorized**; **surfaced in a "Tu caja" section** on the admin's
Caja screen, above the team.

### Design decisions (✅ = confirmed with product)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 ✅ | **Who may sell / scan** | Widen the POS and tickets route groups to `requireRole('agent', 'admin')`; drop the agent-only `RoleGuard` on `/pos/*` and `/scan`. | Selling and admitting guests are core admin activities. `requireRole` is already variadic — a call-site change, no middleware rewrite. |
| D2 ✅ | **Admin commission** | **Identical to an agent.** The POS handler runs the *exact same* path, snapshotting the folio's commission with no role branch and no setting. *(Rev. 2026-06-11: commission is now **service-based** — `docs/commissions/service-based-commission.spec.md` — the rate comes from the service sold, not from any per-seller value, so "identical to an agent" holds by construction; the earlier `users.baseCommission` dependency is gone.)* | "Earn like everyone else." The admin appears in the commission report (US-A17) as one more seller. |
| D3 ✅ | **The self-authorization rule** | A settlement event normally needs **two parties** (agent hands in → admin confirms; or admin initiates → agent signs). When the seller **is** the admin, both parties are the same person, so the event is **self-authorized**: born `confirmed`, never queued, no ack window. | Reflects elevated permissions without touching accounting. The only thing skipped is the *approval step*. |
| D4 ✅ | **Negative-balance payout** | The admin's **Payout** (US-A25) is **self-confirmed** too — symmetric with the drop. | "Earn like everyone else" stays literal in both directions of the balance. |
| D5 ✅ | **Where the admin's cash lives** | A **Tu caja** section (own drawer: collected · commission · net + an *Entregar* action) pinned **above** **Equipo** (agents' balances + drop queue) on the admin's Caja screen. | The admin reconciles their own drawer in the same place they reconcile the team's. |
| D6 | **Financially inert** | The balance derivation, watermark, carry-forward, and the invariant `balance = carry_forward + cash_collected − commission_total − expense_total + payouts_total` are **unchanged**. Self-authorized events are `confirmed` from birth, so they enter the formula identically. | The balance math is settled, tested, and audited; this feature must not move a single number that wasn't already going to move. |
| D7 | **One admin per org (today)** | Self-authorization is **unconditional** because invites only create `agent` roles → exactly one admin per org, no second admin to defraud. | If a co-admin role is ever introduced, the single seam in D3 is where separation-of-duties confirmation would be reintroduced (logged, not built — Q10 in the IA plan). |

### Scope boundary

| Concern | Owner |
|---|---|
| Widening POS + tickets to admins; admin commission via the agent path; self-authorized drop/payout; the **Tu caja** section + admin *Entregar*/*Payout* actions | **This feature** |
| The running-balance derivation, watermark, carry-forward, expenses, acknowledgments, agent drop confirmation | *Baselines* — **unchanged** |
| The nav restructure, top-bar removal, account surface, shared vocabulary, role-based landing, **Equipo** layout | *App Shell Redesign* (`docs/navigation/app-shell-redesign.spec.md`) — this feature only adds the **Tu caja** block inside the Caja screen it owns |
| The commission rate itself (defined per service) | *Service-Based Commission* (`docs/commissions/service-based-commission.spec.md`) — this feature only relies on the rule being seller-independent |
| Commission/sales **reports by period** (US-A17/A18/A20) | *Reports* feature — this feature only ensures the admin appears as a seller in them |

---

## Data Model

**No new tables, no SQL migration.** Two observations on existing columns:

- ~~**`users.base_commission`**~~ *(Rev. 2026-06-11)*: the "admin earns bonus-only until a base
  is set" caveat described here surfaced in practice as "the admin earns nothing" and was
  resolved by retiring the per-seller rate entirely — commission now comes from the service
  sold (`docs/commissions/service-based-commission.spec.md`), so there is no per-seller value
  to configure and no gap.
- **`cash_drops.status`** (`'pending' | 'confirmed' | 'rejected'`) and
  **`cash_drops.reviewed_by`** already encode everything self-authorization needs: a
  self-confirmed drop is `status='confirmed'` with `reviewed_by = agent_id` (the admin is both
  the agent **and** the reviewer). No new column — `reviewed_by === agent_id` *is* the audit
  marker for "auto-confirmada".

---

## Business Rules (enforced server-side)

1. **POS and tickets admit both roles (D1).** `routes/pos` and `routes/tickets` guard with
   `requireRole('agent', 'admin')`. Every other rule of those features (inventory race
   protection US-AG11, minimum-price floor US-AG06, online-only scan US-AG19, partial
   redemption) is **unchanged** and applies to admins identically.
2. **Admin sales are attributed to the admin (D2).** A folio created by an admin sets
   `agent_id = caller.userId` like any seller, so it rolls up to the admin's own drawer and
   appears in their cash math and in the commission report. No special-casing anywhere in the
   POS handler.
3. **Commission is seller-independent (D2, rev. 2026-06-11).** `commission_amount = Σ` per
   line of the **service's own commission** (percent of line total, or fixed × quantity — see
   `service-based-commission.spec.md` Rule 2). No seller-rate lookup, no role branch: the same
   cart yields the same commission for any seller.
4. **The self-authorization rule (D3).** On creating a settlement event where
   `caller.role === 'admin'` **and** the target agent is the caller themselves, the event is
   born `confirmed`:
   - **Cash drop (hand-in, US-AG14)** — `status = 'confirmed'`, `reviewed_by = caller.userId`
     (instead of `'pending'` / `null`). It **never** appears in the admin's pending-drops
     review queue and reduces the balance immediately.
   - **Payout on a negative balance (US-A25, D4)** — created `status = 'confirmed'`,
     `reviewed_by = caller.userId`, returning the admin's own balance to zero.
   - **Acknowledgment (US-AG27/AG28)** — **N/A**: there is no counterparty to sign, so no
     acknowledgment window is opened and no auto-sign timer runs.
   Implementation seam — a single conditional at drop/payout creation:
   `const selfAuthorized = caller.role === 'admin' && targetAgentId === caller.userId` →
   `status = selfAuthorized ? 'confirmed' : 'pending'`, `reviewedBy = selfAuthorized ?
   caller.userId : null`.
5. **Self-authorization must not leak to agents.** The condition is `role === 'admin' && target
   === self`. An **agent's** own drop is **always** born `pending` and still requires explicit
   admin confirmation (US-A19) — unchanged. An admin recording a collection **from an agent**
   (US-A27 direct collection) is unchanged: that targets *another* user, so it keeps its
   existing semantics (born `confirmed`, owes the agent a signature, opens the ack window).
6. **Accounting is provably unchanged (D6).** The balance formula is unchanged and sums only
   `confirmed` events. The admin's events are `confirmed` from birth, so the shift-scoped
   breakdown (US-A19) still anchors on "most recent confirmed drop" and every figure is
   byte-identical to what it would be if the admin's drop had been confirmed by a (hypothetical)
   second admin one instant later.
7. **Multitenancy.** Every widened route stays scoped to `caller.organizationId`; an admin can
   only sell, scan, collect, and settle within their own org. Cross-org isolation proven with
   `seedTwoOrgs`.

---

## Endpoints

No new routes. Existing routes change behaviour at the guard and at one creation seam.

### `routes/pos/*` and `routes/tickets/*` — widened guard (D1)

```diff
- pos.use('*', authMiddleware, requireRole('agent'))
+ pos.use('*', authMiddleware, requireRole('agent', 'admin'))
```
```diff
- tickets.use('*', authMiddleware, requireRole('agent'))
+ tickets.use('*', authMiddleware, requireRole('agent', 'admin'))
```
Request/response shapes are identical for both roles. `POST /api/pos/folios` snapshots the
caller's commission (Rule 3); `POST /api/tickets/scan` redeems a pass (unchanged).

### `POST /api/cash/drops` (US-AG14) — self-authorized when the caller is the admin (Rule 4)

Same request body. For an **admin** caller the created drop serializes with
`status: "confirmed"` and `reviewed_by` = the admin's id; for an **agent**, `status:
"pending"`, `reviewed_by: null` (unchanged). The response carries an audit hint the UI renders
as **"auto-confirmada"** (`reviewed_by === agent_id`).

### `POST /api/cash/payouts` (US-A25) — self-confirmed for the admin (Rule 4 / D4)

The admin recording a payout against their **own** negative balance creates a `confirmed`
payout, `reviewed_by = self`, zeroing the balance. (A payout the admin records for an **agent**
is unchanged.)

### Commission report (US-A17, future) — admin appears as a seller

No change needed by this feature beyond Rule 2/3 attribution: once the admin sells, they are a
row in the per-seller commission report like any agent.

---

## Frontend (app-guideme)

Layered per the frontend rules. Routing and chrome changes belong to the App Shell Redesign;
**this feature owns only the seller unlock at the route guards and the Tu caja block.**

- **Route access** — drop `RoleGuard role="agent"` from `/pos/*`, `/pos/folio/:id`, and `/scan`
  so admins reach the POS flow and scanner. (The redesign handles role-based landing; this
  feature just removes the gate.)
- **POS & scanner screens** — **reused as-is**. No admin-specific POS UI; the admin sees the
  same cart, checkout (**Cobrar**), folio receipt, and scan-result screens an agent sees.
- **Tu caja (D5)** — on the admin's Caja screen (`pages/CashBalancesPage.tsx` /
  `features/cash/`), a new **Tu caja** section pinned above **Equipo**:
  - Headline: the admin's own drawer — *Cobrado* · *Comisión* · **Neto a entregar** (or *La
    empresa te debe* when negative), reusing the agent `CashBoxCard` presentation.
  - Primary action **Entregar efectivo** → records a **self-confirmed** drop (Rule 4); the
    drawer drops to zero with **no pending state** and no "esperando confirmación" copy.
  - When negative, a **Payout** action self-confirms (D4).
  - Self-confirmed entries render an **"auto-confirmada"** chip in the admin's own drop list,
    distinguishing them from agent hand-ins the admin confirmed.
- **Equipo** — the existing agents'-balances + pending-drops queue, unchanged here (its badge,
  per the redesign, counts only *agent* drops — the admin's never go pending).
- **Data** — the admin's own drawer reuses the agent `GET /api/cash/me` read model (same
  `balance`/`sales`/`commissions` blocks); no new endpoint.

---

## Error responses

No new error cases. Wrong-role access to POS/tickets (e.g. a `client`) → existing
`403 FORBIDDEN`. An agent attempting to self-confirm is impossible by construction (Rule 5):
their drop is always created `pending`.

---

## Scenarios

### US-A31 — Admin sells through the POS

#### S1 — Admin creates a folio
**Given** an authenticated admin in `org_a`
**When** they run the POS flow and `POST /api/pos/folios`
**Then** `201`; the folio is created with `agent_id = admin.userId`, deducts inventory, and is
subject to every POS rule (minimum price, race protection) exactly as an agent's folio.

#### S2 — Admin commission equals the service's commission (US-A33, rev. 2026-06-11)
**Given** a service with a 10% commission (`commission_type='percent', commission_value=1000`)
**When** the admin sells a `line_total = 500000` folio of it
**Then** `commission_amount = round(500000 × 1000 / 10000) = 50000`, snapshotted on the folio —
**byte-identical to what an agent's identical cart yields** — and the admin appears as a seller
in the commission report.

#### S3 — A zero-commission service pays any seller zero
**Given** a service whose `commission_value` is `0`
**Then** a self-sale (or an agent sale) snapshots commission `0` — a valid rate, not an error;
there is no per-seller value that could change it.

### US-A32 — Admin validates access by scanning

#### S4 — Admin redeems a pass
**Given** an admin and a valid folio QR with passes remaining
**When** `POST /api/tickets/scan`
**Then** `200`, one pass redeemed, redemption progress returned — identical to an agent scan;
offline/no-network still returns the US-AG19 network error.

### US-A34 — Self-authorized cash drop

#### S5 — Admin's own drop is born confirmed and skips the queue
**Given** an admin holding a positive own balance
**When** they `POST /api/cash/drops` (Entregar)
**Then** `201` with `status = "confirmed"`, `reviewed_by = admin.userId`; the balance drops
immediately; the drop is **absent** from the admin's pending-drops review queue; no
acknowledgment window is opened.

#### S6 — Accounting is byte-identical (D6)
**Given** the admin's drawer before S5 with `balance = B`
**Then** after S5 the derived balance equals `B − amount`, the shift breakdown re-anchors on
this now-confirmed drop, and **every figure equals** what an agent's confirmed drop of the same
amount would produce — the formula never saw a special case.

### US-A34 / US-A25 — Self-confirmed payout (D4)

#### S7 — Negative own balance zeroed without approval
**Given** an admin whose own balance is `−20000` (electronic-heavy self-sales)
**When** they record a Payout
**Then** `201`, `status = "confirmed"`, `reviewed_by = self`, balance → `0`; no pending state.

### Guard — self-authorization does not leak (Rule 5)

#### S8 — Agent drop still requires admin confirmation
**Given** an agent
**When** they `POST /api/cash/drops`
**Then** `status = "pending"`, `reviewed_by = null`; it appears in the admin's queue and only a
**Confirmar** action moves the balance — **unchanged** by this feature.

#### S9 — Admin's direct collection from an agent is unchanged
**Given** an admin recording a **direct collection** from agent Ana (US-A27)
**Then** the drop targets Ana (not self), so it keeps US-A27 semantics: born `confirmed`,
**owes Ana a signature**, opens the ack window — self-authorization does **not** suppress the
counterparty signature when the target is someone else.

### Roles & Multitenancy

#### S10 — Wrong role
A `client` token on `/api/pos/folios` or `/api/tickets/scan` → `403 FORBIDDEN`.

#### S11 — `seedTwoOrgs` isolation (required)
**Given** an admin in `org_a` and folios/agents in `org_b`
**Then** the `org_a` admin can sell/scan/collect only within `org_a`; their folios, drawer, and
**Equipo** rows never include any `org_b` data, and an `org_a` admin cannot confirm or self-
authorize against `org_b` records.

---

## Definition of Done

**Backend**
- [x] `routes/pos` and `routes/tickets` guard with `requireRole('agent', 'admin')`; all
      existing POS/scanner rules pass unchanged for both roles.
- [x] Admin-created folios attribute `agent_id = caller` and snapshot commission via the
      seller-independent rule (no role branch; service-based as of 2026-06-11) — S1, S2, S3.
- [x] Self-authorization seam in drop creation (`confirmed` + `reviewed_by = self` when
      `role === 'admin'` on the caller-scoped `/me/drops` route) and self-target permitted in
      payout creation — S5, S7, and the leak-guard S8. (Payouts have no review workflow, so
      "self-confirmed" is just allowing the self-target.)
- [x] Balance value/breakdown proven byte-identical to an admin-confirmed agent drop (S6).
- [x] Tests S1–S11 in `test/admin-vendor/admin-vendor-capabilities.test.ts`, including the
      no-leak guards (S8, S9) and `seedTwoOrgs` (S11); 5 stale "admin-forbidden" guard tests in
      the POS/tickets/cash suites flipped to assert the new permitted behavior. Full suite:
      281 passing.

**Frontend**
- [x] `RoleGuard role="agent"` removed from `/pos/*`, `/pos/folio/:id`, `/scan`; admins reach
      the unchanged POS and scanner screens.
- [x] **Tu caja** section on the admin Caja screen (`features/cash/components/TuCajaSection.tsx`):
      own drawer (reuses `CashBoxCard`) + **Entregar** with self-confirmed copy (no pending
      state) + negative-balance **Payout**, pinned above **Equipo**. Self-authorization is
      conveyed by a section caption ("se confirman de inmediato (auto-confirmados)") rather than
      a per-entry chip, since Tu caja shows the drawer + action, not a drop history. The admin's
      own user id (needed for the self-payout target) is now carried on the client `UserPayload`
      — `/api/me` already returned it.
- [x] `pnpm lint:app`, `tsc`, `pnpm build:app` clean.

**Docs**
- [x] `docs/SPEC.md` carries US-A31–A35 and the reorg feature line linking this spec.

---

## Resolved questions

Confirmed with product (2026-06-11):

1. **D2 ✅ Admin commission — identical to agents**, same formula, no setting, no role branch.
2. **D3 ✅ Self-authorization** — the admin's own drops are born `confirmed`; accounting
   unchanged.
3. **D4 ✅ Self-confirmed payout** on a negative admin balance.
4. **D5 ✅ Tu caja on top, Equipo below** on the admin Caja screen.
5. **D7 ✅ One admin per org today** — self-authorization is unconditional; revisit only if a
   co-admin role is ever added (IA plan Q10).
