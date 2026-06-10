# Feature: Advanced Cash Collection — Admin-Initiated Collections & Adjustments

**User stories:** US-A27, US-A28, US-A29 (configurable ack window), US-A30 (dispute resolution) (admin) · US-AG27, US-AG28 (agent)
**Phase:** 2 (Core Enhancements) · **Depends on:** Agent Continuous Cash Balance with Cash
Drops (`agent-balance-cash-drops.spec.md`) — this feature *extends* that model; read it first.

> Enables **face-to-face direct collections** and **adjustments** with a **non-blocking,
> silent acknowledgment workflow** for agents. The admin can take cash from an agent on the
> spot (without waiting for the agent to file a drop) and can correct an agent's drop amount
> on confirm. Every unilateral admin money-move generates a lightweight **signature
> obligation** for the agent that is purely an audit trail — it **never gates** the balance.
> The agent may **sign** it or **dispute** it; if they do neither within the org's window
> (default **24h**), it **auto-signs** so nothing ever blocks.

---

## Context

The baseline model (`agent-balance-cash-drops.spec.md`) is **agent-initiated**: the agent
files a `cash_drop` (`pending`), hands over cash, and the admin **confirms** it. Two gaps
remain for real field operations:

1. **US-A27 — Admin-initiated direct collection.** In person, the admin frequently just
   takes the cash. Forcing the agent to first file a `pending` drop so the admin can confirm
   it is backwards. The admin needs to record the collection directly; the agent's balance
   drops immediately.
2. **US-A28 — Adjust-on-confirm.** Already shipped on the backend (`reviewDrop` writes the
   corrected `amount`, stashes the agent's ask in `amount_requested`, and annotates the
   review note). What is **missing** is the agent's side of it.

Both create a situation where **money moved on the agent's balance without the agent's
explicit agreement at that instant**. US-AG27 / US-AG28 close that loop with a **signature**:
the agent is notified, reviews the discrepancy, and taps **"Firmar / Confirmar"** to agree —
or **"Disputar"** to flag it back to the admin. If they do neither within the window, the
system **auto-signs** to keep the audit trail closed and never block the workflow.

### Design decisions (✅ = confirmed with product)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 ✅ | **Notification surface** | **In-app only** — a "Pendientes de firma" section + badge on the agent's balance/home screen. | No notification subsystem exists today; mobile-first agents open the app daily. Email can be layered on later (Resend is wired) without changing the data model. |
| D2 ✅ | **Auto-sign** | **Derived on read** (deterministic from timestamps), **persisted opportunistically** by a bounded self-scoped sweep on the agent's `GET /me`. | No `scheduled()` handler / Cron Trigger exists. Because acknowledgment is non-blocking, auto-sign is an audit cosmetic — it does not need a guaranteed-timely job. |
| D3 ✅ | **Agent response** | **Sign or dispute.** The agent can acknowledge, **or** raise a dispute (required reason) that flags the item to the admin and **suppresses auto-sign while open**. Dispute resolution is **US-A30**. | The agent needs a real escape valve when an admin records an amount they disagree with — without it, "auto-sign" could rubber-stamp an error. Still **non-blocking**: a dispute never reverses money (see D5). |
| D4 ✅ | **Acknowledgment window** | **Configurable per organization** (`organizations.ack_window_hours`, default `24`, range 1–168). This is **US-A29**. | Different agencies settle on different cadences. One integer column + the existing org settings surface; the derivation reads it per request. |
| D5 | **Disputes are non-blocking & history is frozen** | A dispute **does not** reverse the balance; resolution **does not** retroactively rewrite the settled drop. Corrections are made via a **compensating event** (a new admin collection or a payout) in the current shift. | Preserves the "non-blocking" guarantee and the settlement-watermark / frozen-settled-history invariant (TECH_DEBT §12a). The dispute + resolution is an **audit conversation**, not a financial undo. |
| D6 | **Data model** | **Reuse `cash_drops`**; add orthogonal `source` (who created it) and `acknowledgment` (the signature lifecycle). No new table. | An admin collection *is* a settlement event identical in every financial respect to a confirmed drop. Keeping money-state (`status`) and audit-signature (`acknowledgment`) orthogonal avoids overloading the status enum. |

### Scope boundary

| Concern | Owner |
|---|---|
| **Admin direct collection** (creates a confirmed drop), **adjust-on-confirm**, the **acknowledgment lifecycle** (sign · dispute · admin resolve · auto-sign), in-app pending-signatures + open-disputes surfaces, per-org ack window | **This feature** |
| Agent-initiated `pending` drops, the running-balance derivation, the settlement watermark, expenses, payouts | *Cash Drops baseline* — **unchanged**; this feature plugs into it |
| Email/push notification of the obligation | **Deferred** (D1) — layer on Resend later without schema change |
| Guaranteed-timely auto-sign via Cron | **Deferred** (D2) |
| **Financial** undo of a disputed collection (auto-reversal) | **Out of scope** (D5) — corrected via compensating events |
| Agent Balance UX overhaul, cash-vs-electronic split (US-AG29) | *Separate Phase-2 feature* |

---

## Data Model

No new tables. **Two migrations**: one extends `cash_drops`, one adds the per-org window.

### `cash_drops` — added columns

| Column | Type | Notes |
|---|---|---|
| `source` | `text NOT NULL DEFAULT 'agent'` | enum `['agent','admin']`. `'admin'` = admin-initiated **direct collection** (US-A27). |
| `acknowledgment` | `text NOT NULL DEFAULT 'not_required'` | enum `['not_required','pending','signed','auto_signed','disputed','resolved']`. The agent's **signature lifecycle** for a unilateral admin money-move. Orthogonal to `status`. |
| `acknowledged_at` | `integer` timestamp (nullable) | the instant the lifecycle reached a **terminal** state — set on `signed`, `auto_signed` (`= ack_started_at + window`), or `resolved`. `null` while `pending`/`disputed`/`not_required`. |
| `ack_note` | `text` (nullable) | the **agent's dispute reason** (required on dispute); `null` otherwise. |
| `ack_resolved_by` | `text` → `users(id)` (nullable) | the **admin who resolved** a dispute; `null` otherwise. |

```sql
-- 0025_add_collection_acknowledgment_to_cash_drops.sql
ALTER TABLE `cash_drops` ADD COLUMN `source` text DEFAULT 'agent' NOT NULL;
--> statement-breakpoint
ALTER TABLE `cash_drops` ADD COLUMN `acknowledgment` text DEFAULT 'not_required' NOT NULL;
--> statement-breakpoint
ALTER TABLE `cash_drops` ADD COLUMN `acknowledged_at` integer;
--> statement-breakpoint
ALTER TABLE `cash_drops` ADD COLUMN `ack_note` text;
--> statement-breakpoint
ALTER TABLE `cash_drops` ADD COLUMN `ack_resolved_by` text REFERENCES `users`(`id`);
```

The admin's **resolution note** is appended to the existing `review_note` (which already
accumulates audit annotations, e.g. the adjust delta) — no extra column.

### `organizations` — added column

```sql
-- 0026_add_ack_window_to_organizations.sql
ALTER TABLE `organizations` ADD COLUMN `ack_window_hours` integer DEFAULT 24 NOT NULL;
```

Backfill is implicit via defaults: existing drops become `source='agent'`,
`acknowledgment='not_required'` (the historical truth — no admin ever adjusted or
direct-collected before this feature); every org gets a `24`h window.

### The dimensions, explained

- **`status`** (`pending|confirmed|rejected`) — unchanged **money state**: only a `confirmed`
  drop reduces the balance. An admin collection reduces the balance *because it is `confirmed`*.
  This feature does **not** touch the derivation.
- **`source`** (`agent|admin`) — who created the row. UI labelling + audit. Financially inert.
- **`acknowledgment`** — the agent's signature lifecycle on a unilateral admin money-move.
  **Financially inert** — never affects `balance`, `balance_after`, or the watermark.

### Acknowledgment lifecycle

```
                       (admin direct-collect, or admin confirms with adjusted amount)
                                              │
                                              ▼
   not_required ◄─(confirm-as-asked,reject)  pending ──(agent signs)──────────► signed
                                              │  │
                          (agent disputes,    │  └──(window elapses, derived)──► auto_signed
                           required reason)    │
                                              ▼
                                          disputed ──(admin resolves, note)───► resolved
```

| Event | `status` | `source` | `acknowledgment` |
|---|---|---|---|
| Agent files a drop (baseline) | `pending` | `agent` | `not_required` |
| Admin confirms **as requested** | `confirmed` | `agent` | `not_required` |
| Admin confirms with an **adjusted amount** (US-A28) | `confirmed` | `agent` | **`pending`** |
| Admin **rejects** a drop | `rejected` | `agent` | `not_required` |
| Admin **direct-collects** (US-A27) | `confirmed` | **`admin`** | **`pending`** |
| Agent **signs** (US-AG27/28) | — | — | `pending → signed` |
| Window elapses unsigned (D2) | — | — | `pending → auto_signed` (derived) |
| Agent **disputes** (D3) | — | — | `pending → disputed` |
| Admin **resolves** the dispute (D5) | — | — | `disputed → resolved` |

> **`amount_requested`** (existing) still holds the agent's original ask on the adjusted-confirm
> path (*"reportaste $X · registrado $Y"*); `null` for an admin direct collection.

---

## Business Rules (enforced server-side)

All baseline rules (running balance, watermark, multitenancy, ownership) hold unchanged.
This feature adds:

1. **Admin direct collection (US-A27).** `POST /api/cash/collections` `{ agent_id, amount,
   note? }` creates a `cash_drop`: `source='admin'`, `status='confirmed'` (effective
   **immediately**), `acknowledgment='pending'`. `balance_before` = the agent's **live derived
   balance**; `balance_after = balance_before − amount` (the **settlement watermark**), so it
   becomes the agent's **new anchor**. `reviewed_by` = admin (context), `reviewed_at =
   created_at = now`. `agent_id` must be an **agent in the admin's org** (else `404`).
   `amount` integer `> 0`; the resulting balance **may go negative** (baseline Rule 2).
   `organization_id`/`source`/`status`/`balance_*` come from context/derivation, never the body.
2. **Adjust-on-confirm owes a signature (US-A28).** In `reviewDrop`, when `decision='confirmed'`
   **and** the recorded `amount ≠ amount_requested`, set `acknowledgment='pending'`. Confirm
   **as requested**, or **reject**, sets `acknowledgment='not_required'`.
3. **Acknowledgment is non-blocking & financially inert.** No acknowledgment transition
   (`pending`/`signed`/`auto_signed`/`disputed`/`resolved`) **ever** changes `balance`,
   `balance_after`, the watermark, or any derivation. The money already moved via
   `status='confirmed'`.
4. **Agent signs (US-AG27/AG28).** `POST /api/cash/me/drops/:id/acknowledge` flips
   `acknowledgment` `pending → signed`, `acknowledged_at = now`. Scoped to `agent_id = caller`.
   `404` unknown/not-owned/cross-org; `409` if effective acknowledgment is not `pending`.
5. **Agent disputes (D3).** `POST /api/cash/me/drops/:id/dispute` `{ note }` (note **required**,
   non-empty trimmed) flips `pending → disputed`, stores `ack_note = note`. Scoped to
   `agent_id = caller`. `404` as above; `409` if effective acknowledgment is not `pending`
   (you can only dispute **before** the window closes — see Rule 7). A disputed drop
   **suppresses auto-sign** and leaves `pending_acknowledgments`; the **balance is unchanged**
   (D5 — non-blocking, no reversal).
6. **Admin resolves a dispute (D5).** `POST /api/cash/drops/:id/resolve-dispute` `{ note }`
   (note **required**) flips `disputed → resolved`, sets `ack_resolved_by = admin`,
   `acknowledged_at = now`, and **appends** the resolution note to `review_note`. It does
   **not** alter any amount or balance. If the collection was genuinely wrong, the admin issues
   a **compensating event** — a `payout` (to credit the agent) or a new collection — through the
   existing watermark-safe paths. `404` unknown/cross-org; `409` if not `disputed`.
7. **Auto-sign (D2, configurable D4).** `ack_started_at = reviewed_at`; `window =
   org.ack_window_hours × 3600`. A **`pending`** row is **due** when `now ≥ ack_started_at +
   window` and is then presented as `auto_signed` with `acknowledged_at = ack_started_at +
   window`. **Only `pending` auto-signs** — `disputed` never does. The derivation is applied in
   **every** serializer; `GET /me` additionally runs a bounded self-scoped `UPDATE` persisting
   the caller's due rows. (Admin reads derive for display; a `GET` never writes rows it doesn't
   own.)
8. **Surfaces.** `GET /me` returns `pending_acknowledgments[]` (effective `pending` only) + count.
   The admin drops list accepts `?ack=disputed` (and other states) so the admin has an
   **open-disputes queue**; `disputed`/`resolved` rows serialize their `ack_note` /
   `ack_resolved_by`.
9. **No new `ErrorCode`.** `409 CONFLICT` (illegal transition), `404 NOT_FOUND`
   (unknown/cross-org), `400 VALIDATION_ERROR` (bad/empty body).
10. **Multitenancy & ownership.** Every query filters `organization_id` from context. Collection
    validates the target agent in-org; acknowledge/dispute are scoped to `agent_id = caller`;
    resolve and the disputes queue span the caller's org only.

---

## Endpoints

All **auth-required**; suspended → `403 ACCOUNT_SUSPENDED`; wrong role → `403 FORBIDDEN`;
cross-org/unknown → `404 NOT_FOUND`.

| Method & path | Role | Purpose | US |
|---|---|---|---|
| `POST /api/cash/collections` | admin | **Direct-collect** from an agent (immediate `confirmed`, owes signature) | A27 |
| `POST /api/cash/drops/:id/review` | admin | *(existing)* confirm/reject; adjusted confirm now sets `acknowledgment='pending'` | A28 |
| `POST /api/cash/drops/:id/resolve-dispute` | admin | **Resolve** an agent's dispute (audit close; no money change) | A27/A28 |
| `POST /api/cash/me/drops/:id/acknowledge` | agent | **Sign** a pending admin money-move | AG27/AG28 |
| `POST /api/cash/me/drops/:id/dispute` | agent | **Dispute** a pending admin money-move (required reason) | AG27/AG28 |
| `GET /api/cash/me` | agent | *(extended)* `pending_acknowledgments[]` + count; auto-sign sweep; window from org | AG27/AG28 |
| `GET /api/cash/balances` · `GET /api/cash/drops?ack=&status=&agent_id=` · `GET /api/cash/drops/:id` | admin | *(extended)* serialize `source`/`acknowledgment`/`acknowledged_at`/`ack_note`/`ack_resolved_by`; `?ack=` filter for the disputes queue | A27/A28 |

> **Routing:** `/me/*` stays registered **before** any `/:id`-style admin route (baseline rule).
> `collections` + `resolve-dispute` are admin routes; `acknowledge` + `dispute` are agent routes.

### `POST /api/cash/collections` — admin direct collection (US-A27)

Request: `{ "agent_id": "agt_123", "amount": 50000, "note": "Cobro en ruta" }`
Response `201`: `{ "drop": { …, "source":"admin", "status":"confirmed",
"acknowledgment":"pending", "amount_requested":null, "balance_before":120000,
"reviewed_by":"adm_…", "ack_due_at":1718086400 } }`

### `POST /api/cash/me/drops/:id/acknowledge` — agent signs

No body. `200` → `{ "drop": { …, "acknowledgment":"signed", "acknowledged_at":… } }`.
`404` unknown/not-owned; `409` if not effective-`pending`.

### `POST /api/cash/me/drops/:id/dispute` — agent disputes

Request: `{ "note": "Solo entregué $450, no $480" }` (required).
`200` → `{ "drop": { …, "acknowledgment":"disputed", "ack_note":"…" } }`.
`400` empty note; `404` unknown/not-owned; `409` if not effective-`pending`.

### `POST /api/cash/drops/:id/resolve-dispute` — admin resolves

Request: `{ "note": "Verificado en video; monto correcto" }` (required).
`200` → `{ "drop": { …, "acknowledgment":"resolved", "ack_resolved_by":"adm_…",
"acknowledged_at":…, "review_note":"… — Resolución: …" } }`.
`400` empty note; `404` unknown/cross-org; `409` if not `disputed`. **No balance change.**

### `GET /api/cash/me` — extended

Adds to `balance`: each `drops[]` entry now carries `source`/`acknowledgment`/`acknowledged_at`/
`ack_note`; plus `pending_acknowledgments[]` (each with `ack_due_at = reviewed_at + window`) and
`pending_acknowledgments_count`. Disputed drops appear in `drops[]` as `acknowledgment:"disputed"`,
**not** in `pending_acknowledgments`.

---

## Frontend (app-guideme)

Layered per the frontend rules: types/`features/cash/types.ts`, clients/`services/cashService.ts`,
hooks/`features/cash/hooks/useCash.ts`, components/`features/cash/components/`, assembly/`pages/`.

### Types (`features/cash/types.ts`)

```ts
export type DropSource = 'agent' | 'admin'
export type AckState =
  | 'not_required' | 'pending' | 'signed' | 'auto_signed' | 'disputed' | 'resolved'

// Extend CashDrop: source, acknowledgment, acknowledged_at, ack_note, ack_resolved_by
export interface PendingAck {
  id: string; source: DropSource; amount: number; amount_requested: number | null
  balance_before: number; note: string | null; reviewed_at: number; ack_due_at: number
}
// AgentBalance gains: pending_acknowledgments: PendingAck[]; pending_acknowledgments_count: number
export interface RegisterCollectionInput { agent_id: string; amount: number; note?: string | null }
export interface DisputeInput { note: string }       // required reason
export interface ResolveDisputeInput { note: string } // required
```

### Service (`services/cashService.ts`)

```ts
registerCollection(input): POST /api/cash/collections
acknowledgeDrop(id):       POST /api/cash/me/drops/:id/acknowledge
disputeDrop(id, input):    POST /api/cash/me/drops/:id/dispute
resolveDispute(id, input): POST /api/cash/drops/:id/resolve-dispute
listDrops({ ack, status, agentId }): GET /api/cash/drops?ack=&status=&agent_id=
```

### Agent — Balance screen (`pages/BalancePage.tsx`, US-AG27/AG28, D1/D3)

- **"Pendientes de firma"** inline section (rendered only when count > 0), above the breakdown.
  **Non-blocking & silent** — a card list, never a modal; it never interrupts a sale.
- Each row: source label (**"Cobro directo del administrador"** / **"Ajuste en tu entrega"**),
  the `amount` (+ `amount_requested` as *"reportaste $X · registrado $Y"* when present), the
  `note`, and a subtle countdown from `ack_due_at` (*"se confirma sola en 23 h"*).
- Two actions per row: **"Firmar / Confirmar"** → `acknowledgeDrop`; **"Disputar"** → a small
  dialog requiring a reason → `disputeDrop`. Both invalidate `['cash','me']`. Elegant-minimalist:
  `elevation={0}`, `1px solid divider`, accent on the primary sign button, quiet text button for
  dispute.
- A **badge** (count) on the Balance nav item / home snapshot (US-AG26 surface).
- History chips: **Firmado** / **Auto-firmado** / **En disputa** / **Disputa resuelta** (quiet,
  no action). A `disputed` row shows the agent's reason; a `resolved` row shows the admin's note.

### Admin — Cash screen (`pages/CashBalancesPage.tsx` + drop detail, US-A27/A28, D5)

- **"Registrar cobro directo"** action per agent row → dialog (`amount`, optional `note`) →
  `registerCollection`. Invalidate `['cash','balances']`; balance drops immediately.
- **Open-disputes** surface: a filter/segment (`listDrops({ ack: 'disputed' })`) + a badge for
  open disputes. Each disputed row shows the agent's `ack_note`; a **"Resolver"** dialog requires
  a note → `resolveDispute`. Copy clarifies resolution is audit-only and any correction is a new
  collection/payout (D5).
- Drops queue/detail show each drop's `source` (**"Entrega del agente"** / **"Cobro directo"**)
  and an **acknowledgment chip** (*Pendiente · Firmado · Auto-firmado · En disputa · Resuelta*).
  Read-only for the admin except the resolve action.

### Org settings (D4)

- Surface `ack_window_hours` (default 24) in the admin org-settings form (via the existing
  `organizations` route), with a sane range (e.g. 1–168h). The cash derivation reads it per
  request; no client computation of the deadline beyond rendering `ack_due_at`.

### Hooks (`features/cash/hooks/useCash.ts`)

`useRegisterCollection` / `useResolveDispute` (admin → invalidate `['cash','balances']`,
`['cash','drops']`); `useAcknowledgeDrop` / `useDisputeDrop` (agent → invalidate `['cash','me']`);
`useMyBalance` exposes `pending_acknowledgments` for the badge/section.

---

## Error responses

| Case | Status | Code |
|---|---|---|
| Collection/dispute/resolve with bad/empty body (`amount ≤ 0`, missing `agent_id`, empty `note`) | `400` | `VALIDATION_ERROR` |
| Collection targeting a non-agent / cross-org / unknown agent | `404` | `NOT_FOUND` |
| Acknowledge/dispute an unknown / not-owned / cross-org drop | `404` | `NOT_FOUND` |
| Acknowledge or dispute a drop not effective-`pending` | `409` | `CONFLICT` |
| Resolve a drop that is not `disputed` | `409` | `CONFLICT` |
| Wrong role (agent → `/collections` or `/resolve-dispute`; admin → `/me/.../acknowledge` or `/dispute`) | `403` | `FORBIDDEN` |

---

## Scenarios

### US-A27 — Admin direct collection
- **S1** — Collection reduces balance immediately + owes signature. Balance `1200.00`; admin
  collects `500.00` → `201`, `source='admin'`, `confirmed`, `acknowledgment='pending'`,
  `balance_after=70000`; `GET /me` shows `balance=70000` + 1 pending ack; the drop is the new anchor.
- **S2** — Can go negative. Balance `100.00`; collect `150.00` → `−50.00` (allowed; accent color).
- **S3** — Cross-org / non-agent target → `404`, no row.
- **S4** — Injected `source`/`status`/`balance_*`/`organization_id` ignored.

### US-A28 — Adjusted confirm owes a signature
- **S5** — Confirm `480.00` on a `500.00` ask → `confirmed`, `amount=48000`,
  `amount_requested=50000`, `acknowledgment='pending'`, delta in `review_note`; balance −`480.00`.
- **S6** — Confirm as requested → `acknowledgment='not_required'`; not in `pending_acknowledgments`.
- **S7** — Reject → `not_required`, balance unchanged.

### US-AG27 / US-AG28 — Sign or dispute
- **S8** — Sign → `signed`, `acknowledged_at=now`; leaves `pending_acknowledgments`; balance unchanged.
- **S9** — Dispute (with reason) → `disputed`, `ack_note` stored; **no auto-sign**; leaves
  `pending_acknowledgments`; **balance unchanged** (non-blocking, D5).
- **S10** — Dispute with empty note → `400`.
- **S11** — Sign/dispute a non-`pending` (already signed/auto/disputed/resolved/not_required) → `409`.
- **S12** — Acknowledge/dispute another agent's / cross-org drop → `404`.
- **S13** — **Auto-sign** (configurable window). With `ack_window_hours=24`, a `pending` drop with
  `reviewed_at = now−25h` reads as `auto_signed`, `acknowledged_at = reviewed_at+24h`, absent from
  `pending_acknowledgments`; persisted on the agent's next `GET /me`. A **`disputed`** drop with
  `reviewed_at = now−25h` stays `disputed` (never auto-signs). Changing the org window to `48`
  re-opens the first as effective-`pending` until 48h.
- **S14** — **Signing/disputing is financially inert.** `balance`, `balance_after`, and the shift
  breakdown are identical before/after any acknowledgment transition.

### US-A27/A28 — Admin resolves a dispute (D5)
- **S15** — Resolve a `disputed` drop with a note → `resolved`, `ack_resolved_by=admin`,
  `acknowledged_at=now`, resolution appended to `review_note`; **balance unchanged**.
- **S16** — Resolve a non-`disputed` drop → `409`; empty note → `400`; cross-org → `404`.
- **S17** — Compensating correction. Admin agrees the collection was `30.00` too high → registers a
  `payout` of `30.00`; balance rises by `30.00` in the current shift; the original drop stays
  frozen and `resolved`.

### Roles & Multitenancy
- **S18** — Wrong role → `403` (matrix above).
- **S19** — **`seedTwoOrgs` isolation (required).** Org-B admin cannot collect from / resolve an
  Org-A agent's drop (`404`); Org-A pending acks + disputes invisible/unreachable to Org-B; an
  Org-A agent cannot acknowledge/dispute an Org-B drop (`404`).

---

## Definition of Done

**Backend**
- [ ] Migrations `0025_add_collection_acknowledgment_to_cash_drops.sql` (source, acknowledgment,
      acknowledged_at, ack_note, ack_resolved_by) + `0026_add_ack_window_to_organizations.sql`;
      Drizzle schema + regenerated types.
- [ ] `POST /api/cash/collections` (admin): in-org validation, immediate `confirmed` + watermark,
      `acknowledgment='pending'`, context-sourced fields.
- [ ] `reviewDrop`: `acknowledgment='pending'` iff confirmed with an adjusted amount.
- [ ] `POST /me/drops/:id/acknowledge` (sign) and `/dispute` (required reason) — ownership-scoped,
      `pending`-guarded.
- [ ] `POST /drops/:id/resolve-dispute` (admin): `disputed → resolved`, append note, no money change.
- [ ] Derived auto-sign (`ack_started_at + org.ack_window_hours`) in every serializer; `pending`
      only (never `disputed`); opportunistic self-scoped sweep on `GET /me`.
- [ ] `GET /me` returns `pending_acknowledgments[]` + count; admin serializers expose
      `source`/`acknowledgment`/`acknowledged_at`/`ack_note`/`ack_resolved_by`; `listDrops` `?ack=`
      filter.
- [ ] `ack_window_hours` read on the organizations route (get + admin update, range-validated).
- [ ] Schemas strip server-owned fields; required non-empty notes on dispute/resolve.
- [ ] Tests: S1–S19, incl. **`seedTwoOrgs`** cross-org and financial-inertness (S14).

**Frontend**
- [ ] Types + service (`registerCollection`, `acknowledgeDrop`, `disputeDrop`, `resolveDispute`,
      `listDrops({ack})`) + hooks.
- [ ] Agent "Pendientes de firma" inline section (non-modal) + sign/dispute actions + nav/home badge
      + history chips (incl. *En disputa* / *Resuelta*).
- [ ] Admin "Registrar cobro directo" dialog, open-disputes queue + "Resolver" dialog, source +
      acknowledgment chips on queue/detail.
- [ ] Org-settings field for `ack_window_hours`.
- [ ] `pnpm lint:app`, `tsc`, `pnpm build:app` clean.

**Docs**
- [ ] `docs/SPEC.md` Phase-2 line checked off when shipped; `TECH_DEBT.md` notes deferred email
      notification (D1) and Cron auto-sign (D2).

---

## Remaining open question

- **Compensating-correction ergonomics (D5):** after resolving a dispute in the agent's favour,
  the admin currently corrects via a separate `payout`/collection. Acceptable for v1, or do you
  want a one-tap **"Resolver y compensar"** that resolves the dispute *and* registers the
  offsetting event in a single action? (Pure UX sugar over the same primitives — no model change.)
