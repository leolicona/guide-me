# Data Model: Automatic Transfer Verification with Devolada

**Migration**: `0073_devolada_transfer_verification.sql`.
- The number is the next free one: `0071` is Better Auth, and `0072` is reserved for the drop of the password columns (`.specify/debt/password-material`). If that changes before this lands, take the next free number.
- It is additive and hand-written, like every migration here; `api-turistear/src/db/schema.ts` mirrors it by hand.
- It runs before the code on deploy, and the code already deployed never reads the new tables.

**Conventions**:
- **Tenant scope (constitution III)**: every new table carries `organization_id TEXT NOT NULL REFERENCES organizations(id)` and an index led by it.
- **Instants**: epoch seconds (`integer`, Drizzle `mode: 'timestamp'`). Devolada's milliseconds are converted in `services/devolada.ts` (research D5).
- **Money (constitution II)**: integer minor units.
- **Enumerations**: TypeScript-only, like the rest of the schema; the SQL columns are `TEXT` without `CHECK`.

## Relationships

```text
organizations 1 ──── 0..1 devolada_connections
folios        1 ──── *    devolada_links ──── *  devolada_payments
devolada_links * ─── 0..1 folio_payments        (the ledger row a sale/deposit link collects,
                                                  or the settlement row it produced — D8)
devolada_links * ─── 0..1 folio_lines           (per-line settlement)
devolada_payments ·· *    devolada_events       (by devolada_payment_id; no FK — the inbox
                                                  only de-duplicates notifications)
```

## New tables

### `devolada_connections` — one per organization (research D1–D3)

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | |
| `organization_id` | text NOT NULL → organizations | **UNIQUE**: at most one connection |
| `status` | text NOT NULL | `connected` · `broken` · `disconnected` |
| `mode` | text NOT NULL | `real` · `test`, learned from the probe (D2) |
| `credential_ciphertext` | text NULL | base64url AES-256-GCM output; NULL once erased (D12) |
| `credential_iv` | text NULL | base64url 96-bit IV, fresh per write; NULL with the ciphertext |
| `key_hint` | text NOT NULL | last four characters of the key, the only part ever returned |
| `webhook_url` | text NULL | the address we registered at Devolada (`DEVOLADA_WEBHOOK_URL`); NULL where none is registered (local) |
| `replaced_webhook_url` | text NULL | the address the admin agreed to replace (FR-006) |
| `broken_reason` | text NULL | `DEVOLADA_CREDENTIAL_REJECTED` · `DEVOLADA_BUSINESS_SUSPENDED` · `DEVOLADA_CHANNEL_UNAVAILABLE` |
| `broken_at` | integer NULL | |
| `credit_paused_at` | integer NULL | set when a payment reports `queued_for_credit`; cleared when one validates again |
| `last_verdict_at` | integer NULL | last final verdict applied (FR-005) |
| `connected_by` | text NOT NULL → users | |
| `connected_at` | integer NOT NULL | |
| `disconnected_by` | text NULL → users | |
| `disconnected_at` | integer NULL | |
| `created_at`, `updated_at` | integer NOT NULL | |

**States**:

```text
(none) ─ admin connects ───────────────────────────────▶ connected
connected ─ any call answers AUTHENTICATION_ERROR,
            BUSINESS_SUSPENDED or CHANNEL_UNAVAILABLE ──▶ broken
broken ─ admin replaces the key, or a later call succeeds ▶ connected
connected | broken ─ admin disconnects ─────────────────▶ disconnected
disconnected ─ admin connects ─────────────────────────▶ connected
disconnected ∧ no unresolved link ─ sweep ─────────────▶ credential erased (row kept for audit)
```

**Rules**:
- A sale gets a payment link only while the connection is `connected` (FR-004, FR-010).
- A `broken` connection makes new transfer sales fall back to the manual path.

### `devolada_links` — one per transfer we asked for (D6–D8, D13)

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | also the `Idempotency-Key` of the create (D6) |
| `organization_id` | text NOT NULL → organizations | |
| `folio_id` | text NOT NULL → folios | sent to Devolada as `customerRef` |
| `folio_line_id` | text NULL → folio_lines | set for a per-line settlement |
| `folio_payment_id` | text NULL → folio_payments | sale/deposit: the pending row at issue; settlement: the row recorded on confirmation (D8) |
| `kind` | text NOT NULL | `sale` · `deposit` · `settlement` |
| `mode` | text NOT NULL | `real` · `test`, copied from the connection |
| `amount` | integer NOT NULL | > 0; Devolada's `askCents` |
| `devolada_link_id` | text NULL | **UNIQUE** globally; webhooks are routed by it (D4) |
| `url` | text NULL | the payer's page, sent by WhatsApp |
| `expires_at` | integer NOT NULL | D7 |
| `state` | text NOT NULL | see below |
| `closed_reason` | text NULL | `cancelled` · `rejected` · `amount_changed` · `settled_otherwise` · `verified_by_admin` · `abandoned`, each written as D13 says |
| `requested_by` | text NOT NULL → users | the seller who issued it; becomes `collected_by` of a settlement recorded under D8 |
| `create_attempts` | integer NOT NULL DEFAULT 1 | suffixes the idempotency key after a refusal (D5) |
| `last_checked_at` | integer NULL | last re-read (D12); NULL = never checked, so the next sweep checks it |
| `created_at`, `updated_at` | integer NOT NULL | |

**Indexes**:
- `(organization_id, folio_id)`: correlated reads on sale detail and list (BUG-042).
- `UNIQUE (devolada_link_id)`.
- `(state, expires_at)`: the sweep's selection across organizations, like `sweepExpiredBookings`.
- Partial `UNIQUE (folio_id) WHERE kind = 'settlement' AND state IN ('creating','open')`: one open settlement link per sale. A repeated settle request returns that link.
- Partial `UNIQUE (folio_payment_id) WHERE state IN ('creating','open')`.

**States**:

```text
creating ── 201 ─────────────────────────────────────▶ open
creating ── refusal ─────────────────────────────────▶ failed   (final; sale on the manual path)
creating ── timeout ─────────────────────────────────▶ abandoned
abandoned ── sweep: create replay finds it ──────────▶ closing
abandoned ── sweep: replay is refused ───────────────▶ failed
open ── confirmed applied (D9) ──────────────────────▶ paid     (final)
open ── expired verdict, or past expires_at with
        no payment, after a successful re-read ──────▶ expired  (final; D11 or D8)
open ── past expires_at after a partial, invalid
        or unapplied verdict ────────────────────────▶ expired  (final; the admin decides, FR-016)
open ── the sale stops taking it (D13), or a
        partial/invalid settlement verdict ──────────▶ closing  (never under a payment in flight
                                                                 while the sale lives, D13)
closing ── Devolada acknowledges (or LINK_CLOSED) ───▶ closed   (final)
```

**Rules**:
- `amount` is the exact amount of the payment the link collects:
  - sale: the sale total;
  - deposit: the deposit;
  - settlement: the balance of the sale or of the line.
- It never changes; a new amount means a new link (D13).
- `expires_at` ≤ the first live service start, and ≤ the earliest live line clock for `deposit` and `settlement` (D7).
- A link that would stay open less than 15 minutes is never written: the payment takes the manual path (D7).
- A link is **unresolved** while it is `creating`, `open`, `closing` or `abandoned`: something may still happen to it at Devolada. `paid`, `expired`, `closed` and `failed` are final. A disconnected organization keeps its credential while it has an unresolved link (D12).

### `devolada_payments` — what Devolada reported for a link (D9)

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | the `:id` of the resolve endpoint |
| `organization_id` | text NOT NULL → organizations | |
| `link_id` | text NOT NULL → devolada_links | |
| `folio_id` | text NOT NULL → folios | denormalized for indexed reads |
| `devolada_payment_id` | text NOT NULL | **UNIQUE** |
| `status` | text NOT NULL | `validating` · `queued_for_credit` · `confirmed` · `partial` · `unapplied` · `invalid` · `expired` · `superseded` |
| `proof_door` | text NOT NULL | `transfer` · `receipt` |
| `asked_amount` | integer NOT NULL | what the link asked when the customer submitted |
| `claimed_amount` | integer NULL | what the receipt or form says: a claim, never money |
| `received_amount` | integer NULL | what Banxico says arrived (FR-020) |
| `match` | text NULL | `exact` · `short` · `over` |
| `receipt_number` | text NULL | Devolada's `folio` (`DV-…`); shown as «Comprobante Devolada», never as "folio" (FR-022) |
| `verdict_at` | integer NULL | Devolada's `confirmedAt` |
| `awaiting` | text NULL | `payer_tracking_key` |
| `awaiting_reason` | text NULL | `all_used` · `ambiguous` · `no_match` · `unreadable` |
| `devolada_created_at` | integer NOT NULL | |
| `applied_status` | text NULL | the last status D9 acted on; equal to `status` ⇒ nothing to do |
| `applied_at` | integer NULL | |
| `resolution` | text NULL | `accepted` · `dismissed` · `returned` (D15) |
| `resolved_by` | text NULL → users | |
| `resolved_at` | integer NULL | |
| `created_at`, `updated_at` | integer NOT NULL | |

**Indexes**:
- `(organization_id, folio_id)`;
- `(link_id)`;
- `UNIQUE (devolada_payment_id)`;
- `(organization_id, status)` for the attention count.

**Rules**:
- A final status (`confirmed`, `partial`, `unapplied`, `invalid`, `expired`, `superseded`) is never overwritten by an earlier one. Devolada promises the same: "a verdict is final".
- The current payment of a link is its latest non-`superseded` one by `devolada_created_at`.

**Attention** is derived, never stored (constitution II). A payment needs the admin when any of these holds:
- `status ∈ {partial, invalid}` ∧ link `kind = 'settlement'` ∧ `resolution IS NULL`;
- `status = 'unapplied'` ∧ `resolution IS NULL`;
- `status = 'confirmed'` on a cancelled sale ∧ `resolution IS NULL` (treated as `unapplied`, D9);
- `status = 'validating'` ∧ `awaiting IS NOT NULL`;
- `status = 'queued_for_credit'`: validation credit is paused, and the admin tops it up at Devolada.

A sale or deposit with `partial` or `invalid` is attended through the sale's pending verification, as today.

**Flags and counts** (research D14), derived per sale on every read, never stored:
- `devolada_attention`: the sale has at least one payment that needs the admin, as defined above.
- `verification_auto`: the sale is pending verification with a live line; every pending payment row is collected by an `open` link that either has no payment yet and is not past `expires_at`, or whose current payment is `validating` without `awaiting`, even past `expires_at`; and the sale has no attention item. The attention clause arrives with the attention items, in PR 2.
- Each sale counts once in «Por verificar»: `verification − verification_auto + devolada_attention`. The `devolada_attention` count includes only sales that `verification` does not already count, because they are cancelled or their payment verification is not pending.

### `devolada_events` — notification inbox (D4)

| Column | Type | Rules |
|---|---|---|
| `event_id` | text PK | Devolada's `evt_…`, globally unique |
| `organization_id` | text NOT NULL → organizations | |
| `devolada_payment_id` | text NOT NULL | |
| `type` | text NOT NULL | `payment.<status>` |
| `event_created_at` | integer NOT NULL | |
| `received_at` | integer NOT NULL | |
| `attempts` | integer NOT NULL DEFAULT 1 | |
| `outcome` | text NOT NULL | `applied` · `no_change` · `mode_mismatch` · `failed` |

**Index**: `(organization_id, received_at)`.

**Rules**:
- Only events resolved to an organization are stored.
- Unknown links are logged, not stored: there is no organization to scope the row to.
- A `failed` outcome is processed again when Devolada retries.

## Changes to existing types (no column changes)

| Where | Change |
|---|---|
| `folio_events.type` — `FolioEventType` (`utils/folioEvents.ts:14-24`) and its Drizzle mirror (`schema.ts:998-1011`) | New types, listed below the table |
| Existing event `payment_verified` | When automatic: actor NULL, payload `{source: 'devolada', receipt_number, received}` |
| Existing event `payment` (kind `settlement`) | Written by D8 with actor NULL |
| `folios.cancellation_source` and `folio_lines.cancellation_source` | New value `payment_not_received` (D11). Consumers to update: `utils/folioDetail.ts`, `routes/folios/handler.ts`, `routes/pos/handler.ts`, `app:features/folios/types.ts` |
| `folio_payments` | Unchanged shape; see the two cases below the table |
| `folios` | `payment_reference` = the latest receipt number when Devolada confirms; `payment_verified_by` NULL when automatic |
| `ErrorCode` (`src/types/errors.ts`) | The codes of spec FR-023, detailed in `contracts/turistear-api.md` § Error codes |
| Notifications | No new event: `payment_verified`, `tickets_delivered` and `payment_rejected` are reused |

**New `folio_events` types**:
- `payment_link_issued`: actor = the seller; payload `{link_id, kind, amount, expires_at}`.
- `payment_link_closed`: actor = whoever stopped the sale, or NULL; payload `{link_id, reason}`.
- `payment_verdict`: actor NULL; payload `{link_id, status, asked, received, receipt_number, awaiting}`. Written for `partial`, `invalid`, `unapplied` and tracking-key waits.
- `transfer_not_received`: actor NULL; payload `{link_id, kind}`.

**`folio_payments` rows this feature writes**:
- **A row verified by Devolada**: `verification = 'verified'`, `verified_by` NULL, `verified_at` = the verdict, `reference` = the receipt number.
- **A settlement recorded under D8**: `method = 'transfer'`, `verification = 'verified'`, `collected_by` = `link.requested_by`, `created_at` = the verdict.

## Validation rules (enforced server-side — constitution IV)

| Rule | Where enforced | Source |
|---|---|---|
| The key matches `^dk_[0-9a-f]{32}$` and Devolada accepts it | connect | FR-002 |
| A key's mode matches the environment's `DEVOLADA_KEY_MODE` | connect | FR-002, D2 |
| Another notification address is replaced only with `replace_webhook: true` | connect | FR-006 |
| Only admins read or change the connection, or resolve exceptions | routers (`requireRole('admin')`) | FR-001, FR-015 |
| A connected organization's transfer is collected by a link; any `payment_reference` sent is ignored | confirm, settle | FR-009 |
| A link's amount equals the payment it collects | link issue | FR-007 |
| A link is issued only if it stays open at least 15 minutes | link issue | FR-010, D7 |
| One open settlement link per sale; a settlement for another line is refused with `SETTLEMENT_IN_PROGRESS` | partial unique index; settle | D8, D13 |
| While the sale lives, no write closes a link under a payment in flight: a line cancellation or another settlement is refused with `SETTLEMENT_IN_PROGRESS`, and a manual Verificar leaves it open | line cancel, settle, verify | FR-011, D13 |
| A settlement link records at most one settlement: its batch is claimed by `folio_payment_id IS NULL` and every other statement is gated on that claim | settlement core | D8 |
| A verification releases tickets only in the call whose guarded row flip and rollup update both matched | verify core | D10 |
| The system cancellation writes nothing unless its own guarded transition matched | `cancelForUnreceivedTransfer` | D11 |
| A webhook acts only after the signature, the link lookup, the mode check and a re-read with the owning organization's credential | webhook | FR-013 |
| A cancelled sale is never verified. No sale is cancelled automatically while it holds other money, an admin verified it, another of its payments is in flight, or its payment ended *partial* or *invalid* | D9, D11, D12 | FR-016 |
| Every row read or written carries the organization filter beside the id | everywhere; the webhook resolves the organization from the link | constitution III |
