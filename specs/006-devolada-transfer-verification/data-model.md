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
organizations 1 ──── 0..1 devolada_connections ── current ──▶ 0..1 devolada_credentials
organizations 1 ──── *    devolada_credentials  (every key connected; D21)
folios        1 ──── *    devolada_links ──── *  devolada_payments
devolada_links * ─── 1    devolada_credentials  (the link's key: the one that created it,
                                                  unless D21 moved it to the current one)
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
| `current_credential_id` | text NULL → devolada_credentials | the key new links use; NULL while disconnected (D21). Its `mode` and `key_hint` are the connection's |
| `webhook_url` | text NULL | the address we registered at Devolada (`DEVOLADA_WEBHOOK_URL`); NULL where none is registered (local) |
| `replaced_webhook_url` | text NULL | the address the admin agreed to replace (FR-006) |
| `broken_reason` | text NULL | `DEVOLADA_CREDENTIAL_REJECTED` · `DEVOLADA_BUSINESS_SUSPENDED` · `DEVOLADA_CHANNEL_UNAVAILABLE` |
| `broken_at` | integer NULL | |
| `credit_paused_at` | integer NULL | set when a payment of a link on the current credential reports `queued_for_credit`; cleared when a payment stored as `queued_for_credit` moves to any other status, a final verdict included, since a re-read may never show the `validating` in between |
| `last_verdict_at` | integer NULL | last final verdict applied (FR-005) |
| `probed_at` | integer NULL | last time reading a `broken` connection repeated D2's probe; another read probes again only 15 minutes later |
| `connected_by` | text NOT NULL → users | |
| `connected_at` | integer NOT NULL | |
| `disconnected_by` | text NULL → users | |
| `disconnected_at` | integer NULL | |
| `created_at`, `updated_at` | integer NOT NULL | |

**States**:

```text
(none) ─ admin connects ───────────────────────────────▶ connected
connected ─ a call with the current credential answers
            AUTHENTICATION_ERROR, BUSINESS_SUSPENDED
            or CHANNEL_UNAVAILABLE ─────────────────────▶ broken
broken ─ admin replaces the key, or D2's probe passes
         again when an admin opens the connection ──────▶ connected
connected | broken ─ admin disconnects ─────────────────▶ disconnected
disconnected ─ admin connects ─────────────────────────▶ connected
```

Connecting, replacing the key and disconnecting each retire the previous current credential
(`devolada_credentials`, below).

**Rules**:
- A sale gets a working payment link only while the connection is `connected` (FR-004, FR-010).
- A `broken` connection makes new transfer sales fall back to the manual path, and the seller is told why. Each still gets a `failed` link row, without calling Devolada (FR-010, D6).
- While the connection is `broken`, the sales whose links use its current credential are not `verification_auto` (§ Flags and counts): they wait in Por verificar until the key works again (D14).
- An admin opening a `broken` connection repeats D2's probe with the current credential, at most once every 15 minutes (`probed_at`); a success makes it `connected` again.

### `devolada_credentials` — every key the organization connects (research D1, D21)

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | |
| `organization_id` | text NOT NULL → organizations | |
| `mode` | text NOT NULL | `real` · `test`, learned from the probe (D2) |
| `ciphertext` | text NULL | base64url AES-256-GCM output; NULL once erased |
| `iv` | text NULL | base64url 96-bit IV, fresh per write; NULL with the ciphertext |
| `key_hint` | text NOT NULL | last four characters of the key, the only part ever returned |
| `created_by` | text NOT NULL → users | |
| `created_at` | integer NOT NULL | |
| `retired_at` | integer NULL | when another key replaced it, or the admin disconnected |
| `erased_at` | integer NULL | when the sweep erased its ciphertext |

**Index**: `(organization_id, retired_at)`.

**Rules**:
- Every call about a link uses the link's credential: the one that created it, until D21's fallback moves the link to the current one. Only new links use the connection's current credential (D21).
- A retired credential is kept while a link that uses it is unresolved (`devolada_links` § Rules); the sweep erases its ciphertext after (D12). The row stays for audit.
- When Devolada rejects a link's retired credential (`AUTHENTICATION_ERROR`), the link moves to the current credential if that one can read it, or else becomes `failed` (D21). When it rejects the current credential, the connection becomes `broken`, and the links that use it wait until the admin replaces the key. A suspended business (`BUSINESS_SUSPENDED`) is not a rejection: a retired credential's links are retried at the next run.
- While a retired credential has unresolved links, the connection view shows its `key_hint` and how many, so the admin knows not to revoke it at Devolada yet (D21; spec clarification of 2026-10-16).

### `devolada_links` — one per transfer we asked for (D6–D8, D13)

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | also the `Idempotency-Key` of the create (D6) |
| `organization_id` | text NOT NULL → organizations | |
| `folio_id` | text NOT NULL → folios | sent to Devolada as `customerRef` |
| `folio_line_id` | text NULL → folio_lines | set for a per-line settlement |
| `folio_payment_id` | text NULL → folio_payments | sale/deposit: the pending row at issue; settlement: the row recorded on confirmation (D8) |
| `kind` | text NOT NULL | `sale` · `deposit` · `settlement` |
| `credential_id` | text NOT NULL → devolada_credentials | the link's key: the one that created it, or the current one D21's fallback moved it to; every call about the link uses it (D21) |
| `mode` | text NOT NULL | `real` · `test`, copied from its credential |
| `amount` | integer NOT NULL | > 0; Devolada's `askCents` |
| `devolada_link_id` | text NULL | **UNIQUE** globally; webhooks are routed by it (D4) |
| `url` | text NULL | the payer's page, sent by WhatsApp |
| `expires_at` | integer NOT NULL | D7 |
| `state` | text NOT NULL | see below |
| `closed_reason` | text NULL | `cancelled` · `rejected` · `amount_changed` · `settled_otherwise` · `verified_by_admin` · `abandoned`, each written as D13 says; `cancelled` also when the link's own line is cancelled. Set only by a write on our side: a link Devolada's own verdict closes (a `partial` or `invalid` settlement) keeps NULL, and only such a link can still record a settlement (D8, D13) |
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
- `(credential_id, state)`: a credential's unresolved links, for the sweep's cleanup and D21's fallback (D12, BUG-042).

**States**:

```text
creating ── 201 ─────────────────────────────────────▶ open
creating ── refusal ─────────────────────────────────▶ failed   (final; sale on the manual path)
(none) ── no call can succeed (D6) ──────────────────▶ failed   (final; too short, connection broken or key unreadable)
creating ── timeout ─────────────────────────────────▶ abandoned
creating ── no outcome after 5 minutes (D12) ────────▶ abandoned (the request died)
creating ── the sale stops taking it (D13) ──────────▶ closing  (the create still records Devolada's id)
abandoned ── sweep: create replay finds it ──────────▶ closing
abandoned ── sweep: replay is refused ───────────────▶ failed
open ── confirmed applied (D9) ──────────────────────▶ paid     (final; its money reached the sale)
open ── expired verdict, or past expires_at with
        no payment, after a successful re-read ──────▶ expired  (final; D11 or D8)
open ── past expires_at after a partial, invalid
        or unapplied verdict ────────────────────────▶ expired  (final; the admin decides, FR-016)
open ── the sale stops taking it (D13), or a
        partial/invalid settlement verdict ──────────▶ closing  (never under a payment in flight
                                                                 while the sale lives, D13)
closing ── Devolada acknowledges (or LINK_CLOSED) ───▶ closed   (a payment still in flight is
                                                                 followed to its verdict, D12)
closing ── no credential can read it (D21) ──────────▶ failed   (final; the sale already stopped taking it)
closed ── no credential can read it (D21) ───────────▶ failed   (final; its payment in flight can no longer be followed)
open ── no credential can read it (D21) ─────────────▶ failed   (final; D21 says who decides)
```

**Rules**:
- `amount` is the exact amount of the payment the link collects:
  - sale: the sale total;
  - deposit: the deposit;
  - settlement: the balance of the sale or of the line.
- It never changes; a new amount means a new link (D13).
- `expires_at` ≤ the first live service start it collects for, and ≤ the earliest of those lines' clocks for `deposit` and `settlement`. A settlement of one line counts only that line; every other link counts every live line of the sale (D7).
- When no call can succeed, the row is written straight as `failed`, without calling Devolada: the link would stay open less than 15 minutes, the connection is `broken`, or the credential cannot be read here. The payment takes the manual path, and the row shows the admin «Sin enlace de pago — verificar a mano» and keeps a deposit's apartado waiting (D6, D7, D8).
- A link is **unresolved** while it is `creating`, `open`, `closing` or `abandoned`, or while it is `closed` and its current payment is still in flight: something may still happen to it at Devolada. A cancellation or Rechazar closes a link under a payment in flight (D13), and that payment's verdict, usually *unapplied*, is money to return, so the sweep follows it (D12). `paid`, `expired` and `failed` links, and `closed` ones whose payments are final, are resolved. A credential is kept while a link that uses it is unresolved (D21).
- A payment is **in flight** while it is `validating` (awaiting included) or `queued_for_credit`.

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
- `(organization_id, status)` for the attention count;
- `(status, link_id)` for the sweep's selection, across organizations, of payments in flight on closed links (D12).

**Rules**:
- A final status (`confirmed`, `partial`, `unapplied`, `invalid`, `expired`, `superseded`) is never overwritten by an earlier one. Devolada promises the same: "a verdict is final".
- The current payment of a link is its latest non-`superseded` one by `devolada_created_at`.

**Attention** is derived, never stored (constitution II). A payment needs the admin when any of these holds:
- `status ∈ {partial, invalid}` ∧ link `kind = 'settlement'` ∧ `resolution IS NULL`;
- `status = 'unapplied'` ∧ `resolution IS NULL`;
- `status = 'confirmed'` on a cancelled sale ∧ `resolution IS NULL` ∧ its link never ended `paid` (treated as `unapplied`, D9). A `paid` link's money reached the sale before an ordinary cancellation, which priced it *(amended 2026-10-16 in build)*. The same holds on a live sale for a link a write closed first (`closed_reason` set, D13): a cash settlement, or a line cancellation that changed the balance or cancelled the link's line. Its money settled nothing *(amended 2026-10-24 in build, PR 3)*;
- `status = 'validating'` ∧ `awaiting IS NOT NULL`, while nobody has decided the payment by hand;
- `status = 'queued_for_credit'`, while nobody has decided the payment by hand: validation credit is paused, and the admin tops it up at Devolada;
- the payment of a link no credential can read (`failed` by D21), last seen in flight, while nobody has decided it by hand. Its label is the link's, «Sin enlace de pago — verificar a mano».

A payment is decided by hand once its `resolution` is set (an admin's *accept* or *dismiss* of a settlement, D15), once its ledger row on a sale or deposit link is verified (the admin's Verificar), or once its sale is cancelled (Rechazar, or any cancellation). Money that then arrives is covered by the *unapplied* clauses above.

A `settlement` payment **awaits the admin's decision** when it needs the admin through the first clause, or through the `failed` link clause.

**The apartado does not expire** (D8, FR-016): the bookings sweep neither sends its grace notice nor releases it at its release time while:
- a link of the sale is `creating` or `open`;
- a deposit row that a link collects is still pending, whatever the link's state, `failed` and `abandoned` included, a row written `failed` without a call among them: Devolada's verdict, or the admin's Verificar or Rechazar, decides it;
- a settlement payment awaits the admin's decision.

The customer may have paid, and the expiry would otherwise count as collected a deposit that never arrived (research defect 4). A settlement link of one line, and its payment, hold only that line, whose siblings keep their own clocks; every other link, and a pending deposit, hold every line (D8).

A sale or deposit with `partial` or `invalid` is attended through the sale's pending verification, as today.

**Flags and counts** (research D14), derived per sale on every read, never stored:
- `devolada_attention`: the sale has at least one payment that needs the admin, as defined above.
- `verification_auto`: the sale is pending verification with a live line; every pending payment row is collected by an `open` link that either has no payment yet and is not past `expires_at`, or whose current payment is `validating` without `awaiting`, even past `expires_at`; none of those links uses the current credential of a `broken` connection; and the sale has no attention item. The attention clause arrives with the attention items, in PR 2.
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
- `payment_verdict`: actor NULL; payload `{link_id, status, asked, received, receipt_number, awaiting}`. Written for `partial`, `invalid` and `unapplied`, and for `confirmed` on a cancelled sale.
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
| A link is issued only if it stays open at least 15 minutes and the connection is `connected` with a readable credential; otherwise a `failed` row records it, without calling Devolada | link issue | FR-010, D6, D7 |
| A settlement of one line is bounded by that line's own start and clock | link issue | D7 |
| Every call about a link uses the link's credential; a rejected retired one hands the link to the current credential, or marks it `failed`; a rejected current one marks the connection `broken`, and its links wait for the new key; a suspended business is retried | webhook, sweep, link close | FR-004, D21 |
| A payment is followed to its verdict after its link closed too, and its credential is kept until then | sweep | FR-004, FR-012, D12 |
| The admin's *accept* records a settlement for an exception or for a payment still in flight; *dismiss* applies to exceptions only | resolve | FR-018, D15 |
| One open settlement link per sale; a transfer settlement for another scope (another line, or the whole sale against one line's link, and the reverse) is refused with `SETTLEMENT_IN_PROGRESS` | partial unique index; settle | D8, D13 |
| A settlement link closes only when the write touches what it collects: its own line, or the whole sale | line cancel, settle | D13 |
| While the sale lives, no write closes a link under a payment in flight: a line cancellation or a cash settlement that would close it is refused with `SETTLEMENT_IN_PROGRESS`, and a manual Verificar leaves it open | line cancel, settle, verify | FR-011, D13 |
| An apartado never expires while it has a link being created or open, a pending deposit row that a link collects, or a settlement payment awaiting the admin's decision; a settlement of one line holds only that line | bookings expiry sweep | FR-016, D8 |
| While the connection is `broken`, no sale whose link uses its current credential is `verification_auto` | flags, counts | FR-015, D14 |
| A settlement link records at most one settlement: its batch is claimed by `folio_payment_id IS NULL` and every other statement is gated on that claim | settlement core | D8 |
| A verification releases tickets only in the call whose guarded row flip and rollup update both matched | verify core | D10 |
| The system cancellation writes nothing unless its own guarded transition matched | `cancelForUnreceivedTransfer` | D11 |
| A webhook acts only after the signature, the link lookup, the mode check and a re-read with the link's credential, one of the owning organization's own | webhook | FR-013, D21 |
| A cancelled sale is never verified. No sale is cancelled automatically while it holds other money, an admin verified it, another of its payments is in flight, or its payment ended *partial* or *invalid* | D9, D11, D12 | FR-016 |
| Every row read or written carries the organization filter beside the id | everywhere; the webhook resolves the organization from the link | constitution III |
