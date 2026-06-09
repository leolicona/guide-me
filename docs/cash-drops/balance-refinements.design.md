# Design & Implementation Plan: Agent Cash-Balance Refinements

> Pays down **TECH_DEBT §12 — Agent Cash-Balance — Deferred Refinements (a–e)**.
> Builds on `docs/cash-drops/agent-balance-cash-drops.spec.md`. Touches
> `src/routes/cash/handler.ts`, `src/db/schema.ts`, and `test/cash/agent-balance-cash-drops.test.ts`.

## 1. The five deferred items (recap)

| | Refinement | Nature |
|---|---|---|
| **(a)** | Settled history is not frozen — a pre-drop expense delete / folio cancellation silently moves a number the admin already settled | Correctness-of-record (invisible until an admin settles then history back-edits) |
| **(b)** | `deriveBalance` re-aggregates **all** of an agent's history on every read — O(history), grows forever | Performance / scale |
| **(c)** | No adjust-amount-on-confirm — a wrong drop must be rejected & re-registered | UX / workflow |
| **(d)** | `listBalances` is N+1 — one full `deriveBalance` per agent in a loop | Performance / scale |
| **(e)** | Coarse shift attribution — the breakdown anchors on `created_at`, so out-of-order confirmations and post-drop cancellations fold into `carry_forward` | Reporting fidelity |

## 2. Key insight — one primitive resolves (a), (b), and (e)

The current derivation has **no settlement watermark**: it re-sums the entire event history on every read, and re-derives `carry_forward` as a *balancing term* so the breakdown always reconciles. Every deferred item except (c)/(d) traces back to that one missing primitive.

**Add a `balance_after` snapshot to each confirmed drop** — the agent's authoritative balance at the instant the admin confirmed it. That single column is a settlement watermark, and it unlocks all three:

- **(b)** The authoritative balance becomes `anchor.balance_after + Σ(events since the watermark)` — bounded by *shift* size, not history.
- **(e)** Anchor on the **settlement timeline** (`reviewed_at` of the most-recently-confirmed drop) instead of `created_at`. Out-of-order confirmation now anchors on the drop that was actually confirmed last. And `carry_forward` is read **directly** from `anchor.balance_after` instead of computed as a balancing term — so `deriveBalance` and `deriveShiftBreakdown` collapse into **one** function.
- **(a)** A snapshot is only correct if pre-watermark rows can't silently change underneath it. That forces us to *handle* the two pre-watermark mutation vectors — which is exactly what (a) asks for (see §4).

Two facts from the current codebase make the snapshot **exactly correct**, not an approximation:

1. `folios.amount_paid` is written **once** at creation (`pos/handler.ts`) and **never grown** afterward. The "booking whose `amount_paid` grows across a drop" half of (e) is **currently unreachable** — so no partial-payment event stream is needed for correctness today.
2. The only post-creation mutation to a folio is **cancellation**, which already stamps `cancelledAt`. That timestamp lets the derivation detect a post-watermark cancellation of a pre-watermark folio **using existing columns** — no new ledger table (see §4).

## 3. Watermark-anchored derivation (resolves b + e)

### 3.1 Schema

Add to `cash_drops` (migration `0024_add_balance_after_to_cash_drops.sql`):

```sql
ALTER TABLE cash_drops ADD COLUMN balance_after integer; -- nullable
```

- `NULL` for `pending` / `rejected` drops and for confirmed drops created before this migration.
- Set **only** at confirm time, in `reviewDrop`.

Drizzle (`schema.ts`): `balanceAfter: integer('balance_after')` (nullable).

### 3.2 Anchor

```
anchor = the confirmed drop with the greatest reviewed_at
         (tiebreak: greatest created_at) whose balance_after IS NOT NULL
```

Anchoring on `reviewed_at` (the settlement instant), not `created_at`, is the (e) fix: a drop created early but confirmed late correctly becomes the anchor.

### 3.3 Balance

```
if anchor exists:
  balance = anchor.balance_after
          + Σ cash_collected   (cash, non-cancelled, created_at > anchor.reviewed_at)
          − Σ commissions      (kept,               created_at > anchor.reviewed_at)
          − Σ expenses         (                    created_at > anchor.reviewed_at)
          + Σ payouts          (                    created_at > anchor.reviewed_at)
          − Σ reversals        (pre-watermark cash folios cancelled after the watermark — §4.2)
else:
  balance = full-history derivation   (today's deriveBalance — the fallback path)
```

There is **no confirmed-drops term** in the anchored sum: the anchor has the max `reviewed_at`, so no drop is confirmed after it; pending drops never affect the balance. When a new drop is later confirmed it becomes the next anchor and advances the watermark.

**Invariant (regression gate):** for any history, the anchored balance **must equal** today's full-recompute balance. This is the headline test — the optimization is behavior-preserving for the authoritative number.

### 3.4 Breakdown unification (e)

`carry_forward` is no longer a balancing term — it **is** `anchor.balance_after` (the balance carried into the shift). So:

```
balance = carry_forward(= anchor.balance_after) + collected − commissions − expense_total + payouts_since
```

`deriveBalance` and `deriveShiftBreakdown` merge into a single `deriveBalance` returning both the headline and the shift lines from the same since-watermark sums. `last_drop` is the anchor.

> **Intentional semantics change (Scenario 4).** Today a *pre-anchor folio cancelled later* lands in `carry_forward`. Under §4.2 it lands in the **current shift** as a visible reversal line instead. That is the (a) improvement — a settled number stops moving and the reconciliation surfaces live. Scenario 4's expected split changes (the headline `balance` is identical); the test is updated, not just re-pointed.

### 3.5 Confirm path stays bounded too

In `reviewDrop`, compute the new `balance_after` incrementally from the **previous** watermark rather than a full recompute:

```
balance_after = prev_anchor.balance_after
              + Σ(events since prev watermark, up to now)
              − this_drop.amount
```

With no previous anchor, fall back to the full derivation once (first drop only). Each confirmation advances the watermark in O(shift), so even writes never re-scan all history.

## 4. Freezing settled history (resolves a)

A snapshot is wrong the moment a pre-watermark row changes underneath it. Two vectors, two treatments:

### 4.1 Expense / drop deletes — refuse behind the watermark

An expense has no tombstone, so a delete is invisible to the snapshot. Forbid it:

- `DELETE /api/cash/me/expenses/:id`: if the expense's `created_at <= anchor.reviewed_at` (it's settled) → **`409 CONFLICT`** ("This expense was already settled in a confirmed cash drop and can't be removed"). Unsettled expenses delete as today.
- Drop cancel is already guarded to `pending` only; pending drops are never behind a watermark, so no change.

### 4.2 Folio cancellation — post a reversal, don't rewrite

Cancellation is a legitimate admin action that can't be refused, and the folio **already records `cancelledAt`**. So instead of letting a pre-watermark folio silently drop out of a frozen snapshot, the derivation adds a **reversal term computed from existing columns** — no new table:

```
reversal = Σ amount_paid   over CASH folios where created_at <= anchor.reviewed_at
                                            AND cancelled_at  >  anchor.reviewed_at
         − Σ commission     over those of them with cancellation_clawback = true
```

This reverses, **in the current shift**, exactly the cash (and clawed-back commission) that `balance_after` had baked in while the folio was live. The settled snapshot stays frozen; the reconciliation is visible and dated to the cancellation. This is also the seam the future refund-PIN flow (TECH_DEBT §11) plugs into.

> Pre-watermark folios that were *already cancelled* at confirm time are correctly inside `balance_after` and are **excluded** by `cancelled_at > anchor.reviewed_at`, so they're never double-counted.

## 5. Adjust-amount-on-confirm (resolves c)

Let an admin confirm with a corrected amount instead of forcing reject-and-resubmit.

- `reviewDropSchema`: add optional `amount: z.number().int().positive().optional()`, **only** meaningful when `decision === 'confirmed'`.
- `cash_drops`: add `amount_requested integer` (nullable) — the agent's original ask, set **only when an adjustment occurs** (`confirmed amount != requested`); `NULL` means "confirmed as requested."
  - Same migration `0024`: `ALTER TABLE cash_drops ADD COLUMN amount_requested integer;`
- `reviewDrop` on confirm-with-amount: stash the original into `amount_requested`, write the adjusted value into `amount`, append the delta to `review_note` audit (e.g. `"Adjusted from 500.00 to 480.00"`). `balance_after` is then computed from the **adjusted** amount.
- Wire/serializer: expose `amount_requested` so the UI can show "Confirmed 480 (requested 500)".

Reject is unchanged (terminal, balance untouched).

## 6. Grouped balances query (resolves d)

Replace the per-agent loop in `listBalances` with a fixed set of `GROUP BY agent_id` aggregates merged in app code — **O(1) queries** regardless of agent count:

1. agents in org (`users` where role=`agent`)
2. cash_collected per agent (`folios` cash, non-cancelled, `GROUP BY agent_id`)
3. commissions per agent (`folios` kept, `GROUP BY agent_id`)
4. expenses per agent (`agent_expenses GROUP BY agent_id`)
5. confirmed_drops + pending rollup per agent (`cash_drops GROUP BY agent_id, status`)
6. payouts per agent (`payouts GROUP BY agent_id`)

Left-join in memory keyed by `agent_id`, apply the same formula, sort by balance desc. The admin `/balances` view stays **all-time** (company exposure), so it does **not** use the watermark — keeping it a pure aggregate is simplest and the row count is bounded by event volume, not agents². (The watermark optimization targets the per-agent `/me` hot path; `/balances` is an admin-only, lower-frequency call.)

## 7. Implementation plan (phased, low-risk first)

Each phase is independently shippable and independently tested.

### Phase 1 — Grouped balances (d) — *pure perf, zero behavior change*
1. Rewrite `listBalances` with the six grouped queries + in-memory merge.
2. Test: existing Scenario 10 must pass byte-for-byte; add a multi-agent fixture asserting the result equals the old per-agent derivation and that org isolation holds (Scenario 16).
- **Risk: low.** No schema, no API shape change.

### Phase 2 — Adjust-on-confirm (c) — *additive*
1. Migration `0024`: add `amount_requested` (do the `balance_after` column in the same file).
2. `reviewDropSchema` optional `amount`; `reviewDrop` adjustment + audit; serializer exposes `amount_requested`.
3. Tests: confirm-as-requested (`amount_requested` stays `NULL`); confirm-with-adjustment (balance uses adjusted amount, `amount_requested` = original, audit note present); reject unaffected; non-pending → 409.
4. Frontend: drops review dialog gains an optional "confirm with adjusted amount" field; detail shows "requested vs confirmed."
- **Risk: low.** Backward compatible (omitted `amount` = today's behavior).

### Phase 3 — Watermark derivation (b + e) — *the core*
1. `reviewDrop` (confirm branch) computes & stores `balance_after` incrementally (§3.5).
2. Merge `deriveBalance` + `deriveShiftBreakdown` into one watermark-anchored function (§3.3–3.4) with the full-history fallback when no anchored drop exists.
3. **Regression gate test:** a property-style fixture with mixed folios/expenses/drops/payouts asserting anchored balance == full-recompute balance across several histories.
4. Update Scenario 12 (carry_forward now read from `balance_after`) and confirm Scenarios 1–3 still hold.
5. *(Optional)* one-time backfill: compute `balance_after` for existing confirmed drops in `created_at` order. **Not required for correctness** — the fallback path covers `NULL` — but it lights up the fast path for pre-existing data.
- **Risk: medium.** Behavior-preserving for the headline number (gated by the regression test); changes the internals of the hottest read.

### Phase 4 — Freeze settled history (a) — *depends on Phase 3's watermark*
1. Expense delete: 409 when `created_at <= anchor.reviewed_at` (§4.1).
2. Add the cancellation **reversal term** to the derivation (§4.2).
3. Update Scenario 4 (reversal now lands in the current shift, not `carry_forward`); add: delete-settled-expense → 409; cancel a pre-watermark folio → balance reflects the reversal live and the prior settled snapshot is unchanged.
- **Risk: medium.** One intentional, documented breakdown-semantics change (headline balance unchanged).

## 8. Definition of Done

- [ ] Migration `0024_add_balance_after_to_cash_drops.sql` adds nullable `balance_after` + `amount_requested`; Drizzle `cashDrops` updated; `pnpm cf-typegen:api` clean.
- [ ] `listBalances` is O(1) queries (no per-agent loop); Scenario 10 + a new multi-agent equality test pass.
- [ ] `reviewDrop` supports optional confirm `amount` with `amount_requested` audit; serializer exposes it; reject unchanged.
- [ ] `deriveBalance`/`deriveShiftBreakdown` unified and watermark-anchored; `balance_after` set at confirm; **regression test proves anchored balance == full recompute** across mixed histories.
- [ ] Settled expenses refuse deletion (409); post-watermark cancellation of a pre-watermark folio surfaces as a current-shift reversal with the settled snapshot frozen.
- [ ] Scenarios 1–17 updated where noted (4, 12) and still green; multitenancy (16–17) intact via `seedTwoOrgs`.
- [ ] `pnpm --filter api-guideme test` green; `pnpm build:app` clean.
- [ ] TECH_DEBT §12 updated: mark (a)–(e) resolved (or note any deliberately deferred sub-case, e.g. partial-payment event streams, which stay out of scope while `amount_paid` is immutable).

## 9. Explicitly out of scope

- **Partial-payment event streams** for bookings whose `amount_paid` grows across a drop (the unreachable half of (e)). Revisit only if/when an endpoint that grows `amount_paid` on an existing folio is introduced; at that point the reversal pattern in §4.2 generalizes to a signed adjustment ledger.
- Multi-currency, opening float, and any change to the `pending → confirmed | rejected` machine beyond the additive adjust-on-confirm.
