# Feature: Line autonomy — the folio becomes the container, the line owns its money and its life

> **Status: SPEC — not built.** Supersedes, deliberately and by name:
> - `docs/folios/folio-state-machine.spec.md` § Scope boundary items 1–2 (*"`folios.status` keeps
>   exactly three values"* / *"no new writer of state"*) — this feature retires the column itself.
> - `docs/oversight/folio-list-scanability.spec.md` **D4** (*rail = money*) — the rail becomes an
>   attention roll-up (D14 below).
> - `docs/bookings/bookings-down-payments.spec.md` one-shot settle and the single
>   folio-level hold clock (`bookingExpiryEpoch`'s `earliestSlotEpoch`).
>
> Un-defers **US-A22** (`SPEC.md` Out-of-MVP: *"Deferred to simplify inventory logic in MVP"*).
> New stories: **US-LG09 · US-A89 · US-AG54**. Migrations claimed: **0062–0065**.

## Context

The folio is one state machine stretched over purchases that have independent lives, and three
kinds of collateral damage fall out of that — all shipped, all reproducible today:

**1. Cancelling one activity is impossible — since the MVP.** A tourist with Isla Mujeres on
Tuesday and Chichén on Thursday cancels Thursday. The admin's options are: cancel the entire
folio (Tuesday dies too), or do nothing. US-A22 has been deferred since the MVP
(`SPEC.md` § Out of MVP), while the machinery to price it arrived anyway: the cancellation engine
already computes a **per-line** outcome (`LineOutcome`, `cancellationPolicy.ts:167`) — and then
the commit throws the granularity away by writing folio-level columns.

**2. The hold clock of one line kills the other.** `bookingExpiryEpoch`
(`pos/handler.ts:735`) snapshots ONE expiry for the whole folio, computed against the
**earliest** departure. An apartado holding Tuesday + Thursday expires when *Tuesday's* clock
fires — and the sweep cancels the folio entire, Thursday included: a seat three days from
departure, released because a different line's deadline passed. Loss with no beneficiary, the
exact shape US-A87 was written against.

**3. "Pay Tuesday in full, hold Thursday" is not representable.** `amount_paid` is one number on
the folio. No fact in the database says which line the money belongs to, so a line-level money
state cannot be *derived* — any split would be a guess, and a guessed axis is the
`(reembolsado)` bug class again (`folio-state-machine.spec.md` § Context 1).

Meanwhile, half the model already lives on the line: the ladder prices per line, commission
inputs are snapshotted per line (`commission_type`/`commission_value`), fulfilment is derived
per line (US-A85), the QR is per line (`qr_token`), and reschedule petitions already carry
`folio_requests.folio_line_id` (US-AG52). This feature finishes a migration the codebase
started on its own — and gives the one missing fact (money per line) a real owner instead of a
derivation.

## Scope boundary

What this feature must NOT change, checkable by machine:

1. **Fulfilment stays derived and the scanner stays a counter-writer.**
   `api-turistear/src/utils/folioFulfillment.ts` and
   `test/folios/folio-fulfillment.unit.test.ts` pass **unedited**. `redeemed_count` remains the
   only authority; no phase adds a stored fulfilment state (restates `folio-state-machine` D4/D5
   at line level).
2. **The cash engine's sums are untouched.** `folio_payments` rows keep their shape and their
   signs; allocations are *children* of payments, never replacements.
   `test/cash-drops/agent-balance-cash-drops.test.ts` passes unedited through every phase.
3. **Money conservation is an invariant, not a hope.** After every write:
   Σ(allocations of a payment) = `payment.amount`, Σ(allocations of a line) ≤ `line_total`,
   Σ(line allocations of a folio) = Σ(payment rows). Asserted **twice** (D10): over the whole
   database as each backfill migration's verification, and in the write-path tests of each
   phase — which keep guarding after the migration's one run.
4. **Multitenancy isolation model unchanged** — every new table carries `organization_id`;
   every new route ships `seedTwoOrgs` scenarios.
5. **The timeline stays narrative, never authority** (`folio-timeline` rule 7): no money or
   state computation reads `folio_events`, before or after it gains `folio_line_id`.

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **The new fact: `folio_payment_allocations`** — one row per (payment, line, amount); Σ per payment = the payment's amount. A line's money state is **derived from its allocations** (Σ ≥ `line_total` → *pagada* · else → *apartada*); only **cancellation is written** (`cancelled_at/by/source` on the line). | An axis is only real if it has an owner that writes it. Deriving "pagada/apartada" from a folio-level number is a guess, and a guessed axis produced the `(reembolsado)` defect. Allocations give the money a per-line owner; deriving the two live states from them (instead of storing a status column) means the allocation rows and the state can never disagree — one fact, one home (`folio-timeline` D26). Cancellation is written because it is an *action*, not a sum. |
| **D2** | **Seeding: the org's minimum-deposit %, applied per line.** A deposit first funds each line with `minPct × line_total`. | No new configuration: Σ of per-line minimums = the folio minimum that already gates the deposit, so the checkout's floor is unchanged. A per-service minimum (`services.minimum_deposit_pct`) was considered and rejected as speculative config — it is one nullable column away if ever asked for (§ Open). |
| **D3** | **Surplus cascades by earliest departure**: after seeding, the remainder fills the soonest-departing line toward `line_total`, then the next. | Deterministic, explainable in customer words (*"your Tuesday tour is already paid"*), pays the most urgent line first (the one whose clock fires first, D5), and is the rule that produces "una pagada, otra apartada" without seller intervention. Pro-rata surplus was rejected: it converges evenly, never produces the mixed state, and *"why does my Tuesday hold $450?"* has no customer-words answer. |
| **D4** | **Settle is per line, with a "Liquidar todo" shortcut.** Each apartada line's *Liquidar* collects **its** balance, derives it *pagada*, signs **its** QR, books **its** commission. "Liquidar todo" = N line settlements in one batch. A settle payment's allocations are **explicit** — this is where the seller directs money. | The driver story (US-AG54): full payment for Tuesday now, Thursday next week. Building allocations without exposing the per-line gesture would be the fact without its use. The shortcut keeps the common case at one tap. |
| **D5** | **One hold clock per line**: `booking_expires_at` moves to `folio_lines`, computed against **that line's** departure. The expiry sweep cancels line by line; the retention ladder and the US-A87 credit are evaluated per line at its expiry. | A line whose life depends on a sibling's clock is not autonomous — and today the far line is cancelled by the near line's deadline (Context 2), releasing a seat nobody could buy yet. Per-line clocks end the collateral damage; the sweep's pricing path is the same single commit the ladder already mandates. |
| **D6** | **Refund debt lives on the line; the PIN stays on the folio.** `refund_status`/`refund_amount` move to `folio_lines`. `confirmRefund` settles all of the folio's pending line-debts present at the handshake, writing one signed `refund` row (with allocations) per line. | Two lines cancelled on different dates are two debts; folding them into one folio number is the information collapse this corpus keeps paying for. The PIN authenticates the **person** at the counter, not an amount — one tourist, one PIN. Per-line PINs would be friction with no threat model behind it. |
| **D7** | **The PIN rotates: each successful `confirmRefund` consumes it and mints a new one** (`refund_pin_attempts` reset; the portal always shows the current PIN). | The PIN proves presence at *this* handshake. If debt #2 reuses the PIN the agent learned confirming debt #1, the agent can confirm #2 with the tourist absent — the exact scenario the PIN exists to block. Today the flaw is unreachable only because a second debt cannot exist. |
| **D8** | **Clearance is derived per line, no new column**: a line's QR signs when the line is *pagada* AND every payment its allocations touch is `verified`/`not_required`. | `folio_payments.verification` is already per movement (paid-ledger). The line-level answer is a join away; a stored per-line clearance would be a second home for a fact the ledger owns. |
| **D9** | **Commission books per line, at that line's milestones**: percent accrues on money allocated to the line; fixed books when the line reaches *pagada*. `commission`/`commission_reversal` rows in `folio_payments` gain `folio_line_id`; a partial cancellation reverses **only that line's** commission (the split `LineOutcome` already computes). `folios.commission_amount` stays a reconciled roll-up, now Σ of per-line accruals. | The inputs are already snapshotted per line; the reversal math is already per line inside the engine. Folio-level booking would recompute from lines and then discard the per-line result — doing the work without keeping the data. |
| **D10** | **Deterministic total backfill, `backfilled = true` — one code path after** (precedent: migration 0061). Each phase's migration backfills what its columns need, purely from columns that already exist: **paid** folios → every line's allocations sum exactly to `line_total` (a fully-paid folio is unambiguous; only the payment→line detail is reconstructed, oldest payment first through the same cascade); **booking** folios → the D2/D3 seed-and-cascade applied **retroactively** over the historical `amount_paid`; **cancelled** folios → lines arrive cancelled from the folio's own snapshotted columns, the refund debt distributed pro-rata to each line's allocated money; hold clocks **copied** from the folio's snapshot, never recalculated (0064). Mechanics per 0061: deterministic ids + `NOT EXISTS` guards (idempotent re-run), timestamps from the **source** column, `backfilled = 1` on every synthetic row. The conservation invariants run **twice**: over the whole database as each migration's verification, and forever in the write-path tests. | *(Reverses the no-backfill decision taken during the interview: an organization is **live in production**, realized 2026-08-11.)* Orphan rows would force every reader — gates, cards, reports, cancellation — to carry `if (has allocations) … else legacy` indefinitely; the backfill makes "every folio has allocations" true for the whole universe once, so the branch dies before it is born. `backfilled` separates memory from reconstruction — forensic metadata, **never a logic branch** — and makes a wrong seeding rule reparable (`DELETE WHERE backfilled = 1`, re-run corrected). The retroactive cascade is written **once**, in TypeScript (the live path); the migration SQL is verified against it as an **oracle** on a copied fixture, so the rule never exists twice unchecked. |
| **D11** | **`folios.status`: the column dies; the API field survives as a derived roll-up until the epic's last PR.** Worst-case derivation: any line apartada → `booking` · all lines cancelled → `cancelled` · else → `paid`. Readers (lists, facets, search, reports, portal, the five QR gates) migrate to line states PR by PR inside F4; the derived field is deleted in the last one. | One truth (the lines) with no big-bang: rewriting six surfaces + the portal in one release makes any single bug block the whole deploy. With no external API consumers the compat field is a *sequencing convenience within the epic*, not a contract to maintain — so "desaparece del modelo" completes, in order. |
| **D12** | **What stays on the folio**: identity & contact, the portal token and PIN, the delivery axis (`tickets_sent_at`/`tickets_viewed_at`), the reminder claim, and the credit aggregate (`credit_amount` accrues per line-expiry, spends folio-level). | The gesture is one: one WhatsApp send, one portal link, one reminder listing every pending line *inside* the message. Splitting them multiplies agent taps without new information — and converting agent work into taps is the named failure mode of the outbox spec (`folio-state-machine` § Context 3), not its goal. |
| **D13** | **`folio_line_id`, nullable, on `folio_events` AND `notifications`.** Null = folio-scoped (`created`, `tickets_sent`…); set = line-scoped (`payment`, `cancelled`, `rescheduled`…). The outbox re-send guard becomes a **unique expression index** on `(folio_id, COALESCE(folio_line_id,''), event, channel)`. | One story per folio, now naming its protagonists (*"Canceló Chichén Itzá (jue 16) — reembolso $350"*); a separate line-events table would mean braiding two timelines at every render, forever. The `COALESCE` is load-bearing: SQLite treats NULLs as distinct in unique indexes, so a plain composite index would let folio-scoped rows duplicate — and without the line in the key, cancelling line B months after line A **collides with A's guard and the customer is silently never told** (same defect class the guard exists to prevent, pointed the other way). |
| **D14** | **The card: customer stays in the header (US-A82 stands); the rail becomes an attention semaphore** derived from the pending-work set (`folioPendingWork` extended per line): empty → green *(all good)* · work exists → amber *(transfer to verify, balance to collect, live petition, tickets unsent)* · urgent → red *(refund owed, line expiring today)*. Always icon-paired; each line in the card's body carries its own icon + state; one shared derivation feeds rail, pills and facets. | *(User decision.)* A mixed folio has no single honest money color, but it has a single honest answer to *"does this need me?"* — which is the seller's actual question at the list. Deriving rail and pill counts from one function means the color and the count can never disagree (the US-A84 property). Functional colors and the never-color-alone rule per `DESIGN_TOKENS.md` §3 — this spec cites, never restates, hex. |
| **D15** | **Facets (US-A84) become any-line semantics**: a folio appears under *Apartados* if ANY line is apartada — and may appear under two facets at once. | The facet answers "is there work of this kind here?"; a mixed folio genuinely has both kinds. Worst-case (D11) is for the single roll-up field; any-case is for filters. Stating both prevents the two from being implemented as one. |
| **D16** | **Four phases — fact → value → gesture → cleanup** (§ Definition of Done). Each is one migration, one PR-stack, one deployable state. | The repo's proven epic shape (paid-ledger #18–23, timeline #85–86): small squash-merged PRs, reviewable as wholes. F1 changes no behaviour; F2 delivers US-A22 before the clock is touched; F4's readers migrate PR by PR under D11. |

## Data Model

### Phase 1 — migration `0062_folio_payment_allocations.sql`

```sql
-- D1. The money's per-line owner. One row per (payment, line, amount); signed like its parent
-- (payment allocations > 0, refund allocations < 0). Σ per payment = payment.amount, enforced
-- in the write path (same-batch, never reconciled after the fact).
CREATE TABLE folio_payment_allocations (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  payment_id       TEXT NOT NULL REFERENCES folio_payments(id),
  folio_line_id    TEXT NOT NULL REFERENCES folio_lines(id),
  amount           INTEGER NOT NULL,             -- signed minor units, never 0
  backfilled       INTEGER NOT NULL DEFAULT 0,   -- D10: 1 = reconstructed by migration. Forensic
                                                 -- metadata only — no logic may branch on it.
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX folio_payment_allocations_line_idx
  ON folio_payment_allocations (organization_id, folio_line_id);
CREATE INDEX folio_payment_allocations_payment_idx
  ON folio_payment_allocations (payment_id);

-- D10 backfill — every existing folio arrives with its allocations. 0061-style INSERT…SELECT
-- blocks, one per folio class (idempotent: deterministic ids 'alc_' || payment_id || line_id +
-- NOT EXISTS guards; created_at = the SOURCE payment row's timestamp, never the migration's):
--   paid:      Σ per line = line_total EXACTLY — a fully-paid folio is unambiguous; only the
--              payment→line detail is reconstruction (oldest payment first, same cascade).
--   booking:   the D2/D3 seed-and-cascade applied retroactively over amount_paid.
--   cancelled: allocations for their payment AND refund rows (signed), so the per-line ledger
--              story balances to the folio's snapshotted outcome.
-- Every synthetic row: backfilled = 1. The exact SQL is the migration body, verified against
-- the live TypeScript cascade as an oracle (D10; S-16).
```

`confirmSale` and `settleBooking` write allocations in the same `db.batch` as the payment row
(seed + cascade per D2/D3 for a deposit; `line_total` each for a full payment). **Nothing reads
the table in F1** — it is the verified shadow step, exactly `paid-ledger` Step 1's shape.
`seed:local` gains mixed fixtures for the F2/F3 tests; the invariants run over the whole
database as this migration's verification (S-15).

### Phase 2 — migration `0063_line_cancellation.sql`

```sql
-- D1 (the written half) + D6. Line-level cancellation + refund debt.
ALTER TABLE folio_lines ADD COLUMN cancelled_at INTEGER;
ALTER TABLE folio_lines ADD COLUMN cancelled_by TEXT REFERENCES users(id);
ALTER TABLE folio_lines ADD COLUMN cancellation_source TEXT;  -- same enum as folios.cancellation_source
ALTER TABLE folio_lines ADD COLUMN refund_status TEXT NOT NULL DEFAULT 'none';  -- 'none'|'pending'|'refunded'
ALTER TABLE folio_lines ADD COLUMN refund_amount INTEGER;

-- D9: accrual rows point at their line (null on pre-existing test rows; seed regenerates).
ALTER TABLE folio_payments ADD COLUMN folio_line_id TEXT REFERENCES folio_lines(id);

-- D13: the narrative and the outbox name the line.
ALTER TABLE folio_events ADD COLUMN folio_line_id TEXT REFERENCES folio_lines(id);
ALTER TABLE notifications ADD COLUMN folio_line_id TEXT REFERENCES folio_lines(id);
DROP INDEX uq_notifications_folio_event_channel;
CREATE UNIQUE INDEX uq_notifications_folio_line_event_channel
  ON notifications (folio_id, COALESCE(folio_line_id, ''), event, channel);

-- D10 backfill — lines of already-cancelled folios arrive cancelled, copied from the folio's
-- own snapshotted columns. EXACT, not reconstruction: every pre-feature cancellation was total,
-- so cancelled_at/by/source apply to all of the folio's lines verbatim. Only the refund debt's
-- split is reconstruction: refund_amount distributed pro-rata to each line's allocated money
-- (largest-remainder on rounding — the cancellationPolicy.ts weights pattern).
UPDATE folio_lines SET cancelled_at = …, cancelled_by = …, cancellation_source = …,
  refund_status = …, refund_amount = …   -- exact SQL in the migration body
```

### Phase 3 — migration `0064_line_booking_clock.sql`

```sql
-- D5. Each apartada line runs against ITS departure. Same resolver (bookingExpiryEpoch),
-- same policy inputs — evaluated per line instead of against the folio's earliest slot.
ALTER TABLE folio_lines ADD COLUMN booking_expires_at INTEGER;

-- D10 backfill — existing apartada lines COPY the folio's snapshotted expiry, never
-- recalculated: a per-line recalculation could EXTEND a hold already communicated to the
-- customer, silently rewriting a promise. New bookings mint per-line clocks; old ones keep
-- the one they were told (S-17).
UPDATE folio_lines SET booking_expires_at =
  (SELECT f.booking_expires_at FROM folios f WHERE f.id = folio_lines.folio_id)
  WHERE booking_expires_at IS NULL AND …  -- apartada lines only; exact predicate in the body
```

### Phase 4 — migration `0065_retire_folio_status.sql`

```sql
-- D11. The columns whose facts moved to the lines. amount_paid / commission_amount stay as
-- reconciled roll-ups (paid-ledger's contract, now Σ over line allocations/accruals).
ALTER TABLE folios DROP COLUMN status;
ALTER TABLE folios DROP COLUMN booking_expires_at;
ALTER TABLE folios DROP COLUMN refund_status;
ALTER TABLE folios DROP COLUMN refund_amount;
```

**Authoritative vs derived, stated once:** allocations (+ the line's cancellation columns) are
authoritative. *Pagada/apartada*, clearance (D8), the folio's `status` field (D11, until
removed), `pending_balance` per line, the semaphore, and fulfilment are all derivations.
The refund PIN, portal token, delivery axis and credit stay folio-authoritative (D12).

## Business rules (enforced server-side)

1. Every `payment`/`refund` row lands with allocations in the same batch; Σ(allocations) =
   `amount`, no allocation of 0, no allocation to a cancelled line.
2. Σ(allocations of a line) never exceeds `line_total`.
3. A line's money state is derived, never stored: Σ ≥ `line_total` → *pagada*; else *apartada*
   (a cancelled line is whatever its `cancelled_at` says, regardless of sums).
4. A deposit seeds each line at the org minimum % of `line_total`, then cascades the surplus by
   earliest departure (D2/D3). The existing folio-level minimum gate is unchanged (Σ of line
   minimums equals it).
5. A line's QR signs only when the line is *pagada* AND every payment its allocations touch is
   `verified` or `not_required` (D8).
6. Cancelling a line prices **that line** through the existing single commit (ladder snapshot,
   proportional ledger reversal, commission reversal of that line only), releases that line's
   inventory (slot seats / zone seats / stay nights), and leaves its siblings byte-identical.
7. The expiry sweep cancels exactly the lines whose own clock fired (D5); a folio may end half
   expired, half alive.
8. `confirmRefund` (PIN or audited override) settles the folio's pending line-debts, writes one
   signed refund row + allocations per line, then **rotates the PIN** and resets attempts (D7).
9. Commission: percent accrues per allocation event on that line; fixed books when the line
   reaches *pagada*; reversal only ever touches the cancelled line's accruals (D9).
10. One notification row per (folio, line, event, channel), null line = folio-scoped; a re-run
    can never duplicate and a second line's event can never be swallowed by the first's guard (D13).
11. Until F4's last PR, the API's `status` field is the worst-case derivation (D11); after it,
    the field is gone and the five gates read the line.
12. The scanner writes `redeemed_count` and nothing else (scope boundary 1).

## Authorization — who may do this

Unchanged roles, applied per line: line-cancel follows US-A21's admin path (plus the agent's
apartado-cancel path where it exists today, US-AG07.4, now per line); line-settle follows
`settleBooking`'s seller paths (agent own folios · admin org-wide · affiliate/operator per their
existing bounds); `confirmRefund` stays admin. Every route resolves the line **through** the
folio inside the caller's `organization_id`; a cross-org line id returns **404**, never 403.

## API surface

### `POST /api/folios/:id/lines/:lineId/cancel` *(F2 — admin; agent variant per apartado rules)*

Body: `{ reason? }` — clawback is derived from the ladder (US-A70), never accepted from the
client. Response: the folio detail (lines now carrying their own state). Server-derived and
refused from the body: everything money.

### `POST /api/pos/folios/:id/lines/:lineId/settle` *(F3 — sellers)*

Body: the payment (`amount` = that line's balance, method, reference per US-AG41/US-A88 rules).
Writes payment + explicit allocation to that line; signs that line's QR when clearance allows.
`settleBooking` becomes the "Liquidar todo" shortcut: N line-settles in one batch, one payment
row, N allocations.

### Widened reads *(F2–F4)*

Both folio detail GETs and the list rows widen per line: `allocated`, `pending_balance`,
derived state, `booking_expires_at`, `refund_status`/`refund_amount`, `cancelled_*`. The list's
`status` field follows D11.

### Error responses

| Code | HTTP | When |
|---|---|---|
| `FOLIO_LINE_NOT_FOUND` | 404 | Line not in this folio/org (cross-org indistinguishably included) |
| `LINE_ALREADY_CANCELLED` | 409 | Cancel or settle against a cancelled line |
| `LINE_ALREADY_PAID` | 409 | Settle against a line already *pagada* |
| `ALLOCATION_MISMATCH` | 500 | Write-path invariant broke (rule 1–2) — the batch rolls back |

## Frontend

Screens: `FoliosListPage` + `FolioCard` (semaphore rail per D14, per-line state rows),
`FolioDetailPage` / agent detail (per-line `SectionCard` with `MoneyText` balance, per-line
*Liquidar* / *Cancelar* via `ConfirmSheet`/`FormSheet`), `FolioStateSheet` facets (D15),
timeline rendering of line-scoped events (D13). Primitives reused: `MoneyText`, `SectionCard`,
`StatusChip`, `ConfirmSheet`, `FormSheet`, `BottomSheet`. Colors and iconography per
`.design/design-system/DESIGN_TOKENS.md` §3 (functional colors, icon-paired — never
color-alone); this spec introduces no new tokens.

## Scenarios

### US-LG09 — every payment knows which lines it pays

**S-1 — Full payment allocates exactly.** Given a 2-line cart paid in full · When confirmed ·
Then each line's allocations sum to its `line_total` and Σ = the payment row.

**S-2 — Deposit seeds then cascades.** Given lines $1,000 (Tue) + $500 (Thu), org min 30%,
deposit $600 · When confirmed as apartado · Then Tue holds $450, Thu $150 (seed 300/150,
surplus 150 → Tue), both derived *apartada*.

**S-3 — Cascade crosses into pagada.** Same cart, deposit $1,150 · Then Tue = $1,000 →
*pagada* (QR signs, if cleared), Thu = $150 → *apartada*.

**S-4 — Replay writes nothing twice.** Given an express confirm retried with the same
`idempotency_key` · Then one payment row, one allocation set.

### US-A22 — cancel one line, the rest untouched

**S-5 — The sibling survives byte-identical.** Given the mixed folio of S-3 · When Thu is
cancelled · Then Thu's seats release, Thu's commission reverses, Tue's QR still validates at
the scanner, Tue's row is unchanged.

**S-6 — Two debts, two records.** Given two paid lines cancelled on different days, ladder
refunding both · Then two line-level `refund_status='pending'` with their own amounts, and two
`cancelled` notifications (the guard keyed by line, D13).

**S-7 — The PIN rotates between handshakes.** Given debt A confirmed with the current PIN ·
When debt B is later confirmed · Then the PIN from A's handshake is rejected and the portal
shows the new one (D7).

### US-AG54 — apartado and settle, per line

**S-8 — Settle one line only.** Given S-2's folio · When the seller settles Tue ($550) · Then
Tue is *pagada* with its QR signed and its commission topped up; Thu still *apartada*, no QR.

**S-9 — One clock fires, one line dies.** Given per-line clocks where Tue's expiry passes ·
When the sweep runs · Then Tue is cancelled (ladder-priced, credit per US-A87 rules), Thu keeps
its hold and its `booking_expires_at`.

**S-10 — Unverified transfer blocks only its lines.** Given a settle of Tue by transfer,
pending verification · Then Tue is *pagada* but unsigned (rule 5); a cash-funded sibling's QR
is unaffected.

### US-A89 — one list, line-true states

**S-11 — Worst-case roll-up.** Given S-2's folio · Then the API `status` field reads `booking`;
given all lines cancelled · `cancelled` (D11).

**S-12 — Any-line facets.** Given the mixed folio · Then it appears under the *Apartados*
facet; after Thu's cancellation it appears under *Apartados* AND *Cancelados* (D15).

**S-13 — After the column dies.** Given F4 complete · Then the scanner gate answers from the
line: a *pagada* line of a half-cancelled folio validates; the cancelled line's QR refuses.

### Multitenancy isolation (required)

**S-14 — Another org's line is invisible.** Given `seedTwoOrgs` · When org A cancels or settles
org B's line (real ids) · Then `404` — never 403, which would confirm existence.

### Backfill (D10)

**S-15 — The backfill conserves every peso, and re-running writes nothing.** Given a database
seeded with pre-feature folios of all three classes · When `0062` runs (then runs again) · Then
the conservation invariants hold over the entire database, every paid folio's lines each sum to
`line_total`, every synthetic row carries `backfilled = 1` — and the second run inserts zero rows.

**S-16 — SQL and TypeScript tell the same story.** Given a fixture of booking folios with
assorted deposits · Then the migration's retroactive cascade produces allocations identical to
the live TypeScript seed-and-cascade function run over the same rows (the oracle, D10).

**S-17 — An old apartado keeps its promised clock.** Given a pre-F3 booking folio with a
snapshotted `booking_expires_at` · When `0064` runs · Then every apartada line carries exactly
that timestamp — none extended, none shortened.

## Definition of Done

**F1 — the fact** *(migration 0062; no behaviour change)*
- [ ] `folio_payment_allocations` + Drizzle schema; `confirmSale`/`settleBooking` write
      allocations in-batch (S-1…S-4)
- [ ] Backfill: every existing folio allocated, idempotent, `backfilled = 1` (S-15); the SQL
      cascade verified against the TypeScript oracle (S-16)
- [ ] Conservation invariants asserted over the whole DB post-migration AND in write-path
      tests (scope boundary 3)
- [ ] `seed:local` produces mixed fixtures
- [ ] Scope-boundary tests pass unedited

**F2 — US-A22** *(migration 0063)*
- [ ] Line cancel endpoint through the single pricing commit (S-5, S-6)
- [ ] Backfill: cancelled folios' lines arrive cancelled; refund debt distributed pro-rata
- [ ] Per-line refund debt + rotating PIN (S-7); portal shows line-level outcomes
- [ ] `folio_events`/`notifications` line-scoped (D13); timeline renders line names
- [ ] Cross-org (S-14)

**F3 — the gesture** *(migration 0064)*
- [ ] Per-line settle + "Liquidar todo" (S-8, S-10); per-line clock + sweep (S-9)
- [ ] Backfill: existing apartada lines copy the folio's snapshotted clock (S-17)
- [ ] Reminder message itemizes pending lines (folio-level send, D12)

**F4 — cleanup** *(migration 0065)*
- [ ] Readers migrated PR by PR (gates, lists, facets, search, reports, portal) — derived
      `status` field deleted in the last PR (D11; S-11…S-13)
- [ ] Card semaphore + per-line rows (D14); facets any-line (D15)
- [ ] `SPEC.md`: boxes ticked, superseded decisions annotated in their home specs

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| Tourist-initiated **line** cancellation requests | The plumbing exists (`folio_requests.folio_line_id`, `kind`); until extended, a tourist's petition stays folio-scoped and the admin can partial-cancel from the detail — no capability is lost, one is manual. |
| Per-service minimum-deposit % | Speculative config nobody asked for (D2); one nullable column + resolver cascade away. |
| Per-line ticket delivery / reminders | Deliberately not deferred-but-rejected (D12): the gesture is one; revisit only if a real per-line delivery need appears. |

## Known behaviour change

- An apartado's expiry stops cancelling the whole folio: only the expired line dies (S-9). An
  org used to holds vanishing entire will now see partial folios — by design.
- Settle can be partial; the receipt and portal show per-line states.
- The list card's rail changes meaning: money → attention (D14). Announced in the F4 PR.
- The API `status` field becomes derived (identical values for every state reachable today) and
  is later removed with the F4 reader migration.
- **The backfill's honest limit** (D10): for a pre-feature apartado, a *future* line
  cancellation prices against a per-line split the seeding rule reconstructed retroactively —
  the rule did not exist when that deposit was taken. The folio-level money is exact (scope
  boundary 3); only the split of old deposits is reconstruction, and it is marked
  (`backfilled = 1`). Declared here rather than discovered in production — the same posture as
  0061's *"what left no trace is honestly absent"*.

## Open

- Should the tourist portal let the customer *pick lines* on a cancellation request? Smallest
  change: allow `folio_line_id` on `kind='cancellation'` petitions (table already permits it).
- "Liquidar todo" as its own endpoint vs a client-side batch of line settles — decided in F3 by
  whatever keeps one payment row per handed-over sum (the ledger's grain is the money event,
  not the line).
- Whether `folios.settled_at/By` (one-shot settle audit) still means anything once settle is
  per line — candidate for the 0065 drop list; decide in F4 when its readers are inventoried.
