# Feature: Cancellation Policy Engine

## Context

A cancellation refund used to be decided **ad hoc**. There was no place for a company to state
"5 days out we refund everything, same-day we keep half, after departure we keep it all" — so the
two cancellation paths answered the same question differently:

| Path | Tour folio | Stay folio |
|---|---|---|
| `cancelFolio` — admin cancels | `refund_status` stayed `'none'` — **no refund was ever recorded** | 2-tier lodging policy from `organizations.lodging_free_cancel_days` / `lodging_cancel_penalty_pct` (`0039`) |
| `approveCancellationRequest` — admin approves a tourist request | `refund_amount = amount_paid` — **always a full refund** | same, full refund |

The same folio refunded 0 or 100% depending on *who initiated* the cancellation.

### Three phases — read this before anything else

The engine shipped in **three deliberate phases**, and each one reverses a promise the previous
made. All three are documented here because the reasoning matters more than the outcome.

**Phase 1 (`#33`, `#34` — shipped).** The engine was **data-gated**: an org with
`cancellation_policy IS NULL` ran the pre-feature code verbatim, so no existing org changed
behaviour and no existing test needed editing. That constraint is what made a change to money
handling safe to land.

**Phase 2 (this revision).** The gate is **removed**. It had done its job — and it was also the
thing keeping the defect alive, because an org without a policy still got two different answers
from the two paths. Worse, it left **three** pricing implementations coexisting:

| Implementation | Applied to |
|---|---|
| The ladder | Orgs with a policy configured |
| "Record no refund" | Tours, admin path, no policy |
| The `0039` lodging fields | Paid stays, no policy |

…plus a fourth rule overriding them: the tourist path refunding 100% regardless.

Phase 2 reduces that to **one**. Every org gets an explicit ladder, the legacy branches are
deleted, and "no policy configured" ceases to be a reachable state.

> **Governing constraint (replaces the Phase-1 gate):**
> **Every organization has a policy, and the ladder is the only thing that prices a cancellation.**
> No escape hatches, no per-cancellation overrides, no second code path. What an org did not
> choose explicitly, it inherits visibly — as a real ladder it can read and edit in Settings, not
> as an implicit fallback buried in a handler.

This **changes behaviour for every existing organization on day one**. That is the point, not a
side effect. See § Rollout for what changes and what to warn about.

**Phase 3 (this revision — the apartado).** Phase 2 claimed "one computation, every path". It was
not true, and the gap was in the place hardest to see: an **apartado** (`status: 'booking'`) had two
buttons and two answers.

| Path | Phase-2 behaviour |
|---|---|
| Admin cancels the folio | priced by the ladder — then the deposit floor pinned the refund to 0 anyway |
| **Agent taps "Cancelar apartado"** (`pos/handler.ts`) | never reached the engine: `refund_status: 'none'` hard-coded, agent keeps every peso of commission, and the collected money reversed **in full** |
| It expires by itself (sweep) | never reached the engine: retains everything, writes no ledger rows |

Two things fell out of that, both fixed here:

1. **The ladder did not apply to apartados at all.** `booking_deposit_retained_pct` defaulted to
   100, which overrode every tier above it. An admin could write "se devuelve 100%" and the customer
   would still receive nothing. Combined with the Phase-2 default (refund everything, always), it
   produced a split nobody chose: a fully-paid no-show got **100% back**, while an apartado
   cancelled a month ahead got **0%**.
2. **A retained deposit vanished from the books.** The agent path reversed the collected money in
   full regardless of what was retained, so the ledger netted to zero while the cash sat physically
   in an agent's drawer and no cash-drop report ever asked for it — the exact defect the paid-ledger
   proportional reversal fixed on the admin path.

Phase 3 deletes the deposit clause rather than defaulting it to 0 (**D20**), routes the agent path
through the same commit the admin path uses, and replaces the flat inherited default with a real
ladder (**D18 revised**), because a default that refunds every deposit to every no-show is not
conservative — it is a trap that happens to look generous.

> **Governing constraint (extends Phase 2's):**
> **The engine cannot tell an apartado from a fully-paid sale.** `folioStatus` is not an input to
> `computeCancellationRefund`; `amountPaid` is the only thing that differs between them. A rule that
> cannot be expressed cannot drift.

**User Stories:**
- **US-A69** — *As an admin, I want to configure a refund ladder for my company (how much is
  refunded at each distance from departure) so cancellations are priced by policy, not by
  whoever happens to process them.*
- **US-A70** — *As an admin, I want each tier to state what share of their commission the
  selling agent keeps, so a same-day cancellation doesn't silently punish (or reward) the agent.*
- ~~**US-A71** — mark a cancellation as *made by the company*~~ — **withdrawn in Phase 2.** We do
  not distinguish who caused a cancellation; the ladder alone decides. See D10.
- **US-A72** — *As an admin, I want an **affiliate**'s commission retention to be configurable
  separately from my in-house agents', because a reseller and my own staff are not the same
  relationship.*
- **US-A73** — *As an admin, I want to allow (or forbid) my agents to cancel their own sales, so a
  customer who changes their mind two minutes after paying doesn't have to wait for me.*
- **US-A75** — *As an admin, I want my company to already have a cancellation policy I can read
  and edit, instead of an unstated default I have to discover by cancelling something.*
- **US-AG44** — *As an agent, I want to cancel a sale I made during my current shift and hand the
  money back on the spot, from the cash I am still carrying.*
- **US-A74** — *As an admin, I want expired bookings — which the system cancels on its own — to
  follow the same policy as every other cancellation, instead of a hidden hardcoded rule.*

**Builds on:**
- **Total folio cancellation** (`docs/cancellation/total-folio-cancellation.spec.md`) —
  `cancelFolio`, `applyCancellation`, `cancellation_clawback` (US-A26).
- **Tourist portal** (`docs/tourist-portal/tourist-self-service-portal.spec.md`) —
  `approveCancellationRequest`, the refund PIN, `confirmRefund` (audit-only).
- **Paid ledger** (`docs/paid-ledger/spec.md`) — `folio_payments`, `buildCancellationReversal`
  (`utils/folioPayments.ts:132`), decision **D6** (reversal is written at cancellation).
- **Organization timezone** (`docs/timezone/spec.md`) — `utils/tz.ts` (`naiveEpoch`, `orgToday`).
- **Bookings & down payments** (`docs/bookings/`) — `booking_min_down_payment_pct`, and the
  current rule that a booking deposit is non-refundable (US-AG07.4).
- **Service-based commission** (`docs/commissions/service-based-commission.spec.md`) —
  `folio_lines.commission_type` / `commission_value` snapshotted at sale.
- **Affiliate program** (`docs/affiliates/affiliate-setup-commissions.spec.md`) —
  `affiliate_commissions` sets a reseller's per-service rate, but the earned amount lands on the
  **same** `folios.commission_amount` an in-house agent's does. The ladder therefore reaches
  affiliates for free; US-A72 is about being able to treat them *differently*, not about
  reaching them.
- **Agent balance & cash drops** (`docs/cash-drops/agent-balance-cash-drops.spec.md`) — the
  `settlementWatermark` (the agent's most recent confirmed drop) is what bounds US-AG44.
- **Bookings auto-expiry** (`docs/bookings/`, US-AG07 P3) — `sweepExpiredBookings`
  (`routes/pos/sweep.ts`), run by the `*/15 * * * *` cron in `wrangler.jsonc`.

### Scope boundary

| Concern | Owner |
|---|---|
| A configurable per-org refund ladder, evaluated per line, snapshotted at sale | **This feature** |
| The single refund computation shared by **both** cancellation paths | **This feature** |
| Proportional ledger reversal when a policy retains money | **This feature** (contained change to `buildCancellationReversal`) |
| Per-tier agent-commission retention, split in-house vs affiliate | **This feature** |
| A universal inherited default, so "no policy" is unreachable (US-A75) | **This feature** (Phase 2) |
| **Apartados priced by that same ladder; the deposit clause deleted** | **This feature** (Phase 3 — D20) |
| **The agent's *Cancelar apartado* routed through the same commit** | **This feature** (Phase 3) |
| ~~"Cancelled by the company" override~~ | **Withdrawn** — D10 |
| Who may cancel: the agent same-shift permission for PAID sales (US-A73 / US-AG44) | **Deferred** — the existing apartado route is not gated by it |
| ~~Auto-expired bookings routed through the same engine (US-A74)~~ | **Withdrawn** — D21: expiry retains, by decision |
| Releasing seats / flipping status / the cancellation audit columns | *Total folio cancellation* — unchanged |
| Refund PIN, `confirmRefund`, the physical hand-back | *Tourist portal* — unchanged, still audit-only |
| Per-service or per-category policy override | **Deferred** (§ Deferred) |
| `refund_obligations` table, partial hand-backs, choosing the refund method | **Deferred** (§ Deferred) |
| Bulk-cancelling a whole slot (weather) | **Deferred** (§ Deferred) |
| Partial / per-line cancellation | **WON'T HAVE** (SPEC) — a cancellation is still total |

**No new endpoint.** The ladder rides the existing `PATCH /api/organizations/current`
(`updateOrganizationSchema`, `organizations/schema.ts:18`) and the admin cancellation endpoints
keep their paths and gain fields.

`POST /api/pos/folios/:id/cancel` **already exists** — it is US-AG07.4's *"Cancelar apartado"*,
agent-scoped under `/api/pos` because `/api/folios/*` is admin-only by construction
(`foliosRouter.use('*', authMiddleware, requireRole('admin'))`) and that guard is a safety property
worth keeping intact rather than punching a hole through. Earlier revisions of this spec described
it as new, which was wrong and hid the fact that it was pricing cancellations on its own; Phase 3
routes it through the engine. **US-AG44 does not add the route** — it widens it, from booking-only
to any sale inside the agent's shift, behind the `agent_cancellation_enabled` gate. Still deferred.

---

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** *(Phase 1 — superseded by D17)* | ~~**Data gate.** `cancellation_policy IS NULL` bypasses the engine and runs the pre-feature code verbatim.~~ | Kept in the record because it was the right call for landing the engine: it let a change to money handling ship without rewriting the reconciliation suite. It was scaffolding, not architecture — and holding it any longer would have preserved the very defect the engine exists to fix. |
| **D17** | **Every org has a policy; "no policy" is not a reachable state.** A migration backfills every existing org, the org-creation path writes the default for new ones, and `resolvePolicy` keeps a code-level constant so the engine can never fail to price a cancellation. The legacy branches are DELETED, not merely bypassed. | Three pricing implementations coexisting is not a design, it is an accident that survived. Deleting them is the only way the "one computation, every path" property is real rather than conditional. The constant fallback is belt-and-braces: a folio must always be priceable, even if a row is somehow missed. |
| **D18** *(Phase 2 — superseded by D18a)* | ~~**The inherited default refunds 100%, always, and absorbs no commission.** A single terminal tier.~~ | The reasoning was: a default has to be defensible for a company that never asked for it, and "cancelling returns the money unless you say otherwise" is the reading a customer would assume. That held only while the engine priced fully-paid folios — sales an admin was already refunding by hand. It stopped holding the moment the same ladder started pricing apartados (D20). |
| **D18a** | **The inherited default is the spec's worked ladder:** ≥120h → 100% refund, agent keeps no commission · ≥24h → 50% refund, agent keeps its commission · departed → 0% refund, agent keeps its commission. Orgs that had lodging cancel settings get this SAME default — those fields are still NOT translated into a ladder. | A default that refunds every deposit to every no-show is not conservative; it is a trap that happens to look generous, and under D20 it costs real money in the field on day one. This ladder is the one the spec has used as its worked example throughout, so it is the terms the product has always described. Translating the lodging fields is still rejected for the original reason: a stay policy would silently govern that org's TOURS too — terms nobody chose, applied to services they were never written for. **No nag or "unconfigured" banner** is shown: the inherited ladder is a real, readable, editable policy, not a placeholder, and treating it as one would be theatre. |
| **D2** | **A JSON column on `organizations`, not a `cancellation_policies` table.** | Policy is org-level only for now. A column needs no CRUD routes — it slots into the settings PATCH that already exists — and the snapshot is a string copy. A table becomes worth it when per-service overrides land; migrating JSON → table later is additive. |
| **D3** | **The tier states what is REFUNDED; the engine works in RETENTION.** `retention = line_total × (100 − refund_pct)/100`, then `refund = max(0, amount_paid − Σ retention)`. | Retention-first makes deposits fall out for free: a 30% deposit against a 50% retention refunds 0 with no special rule, and the company never chases the customer for the shortfall. Refund-percent-of-paid would hand back most of a small deposit even though the seat was lost. |
| **D4** | **Evaluated per line, retentions summed.** Each line matches its own tier by its own departure. | A folio can hold tomorrow's tour and next week's. Anything else charges the far line the near line's penalty (or vice-versa). It is also the only reading consistent with `line_total` being the base. |
| **D5** | **Tiers are measured in HOURS of time-distance, in the org timezone.** | `0052` fixed exactly this bug for booking buffers: a slot that is calendar-tomorrow can be three hours away. Today `cancelFolio` computes days with `new Date().toISOString()` — UTC, date-only. Hours + `naiveEpoch` is the already-proven pattern. |
| **D6** | **The policy is snapshotted onto the folio at sale.** | The customer agreed to the ladder they were shown. Editing the policy must never re-price a sale already made. Mirrors `folio_lines.commission_value`, snapshotted for the same reason. |
| **D7** | **A redeemed line retains 100%, skipping the ladder.** | The service was delivered. Falls out naturally from D4. |
| **D8** | **The agent's kept commission is capped by what the company retained.** | Otherwise a full-refund tier that also lets the agent keep commission makes the company *lose* money on a cancellation — paying for a sale that was undone. |
| **D9** | **Paid-ledger D6 (reversal written at cancellation) is preserved.** | Moving the reversal to the physical hand-back is more accurate but reopens the drop-watermark premise of the cash engine. Deferred deliberately; see § Deferred. |
| **D10** | **The engine is binding, with NO escape at all.** Neither `cancelled_by_company` (withdrawn) nor the `clawback` request flag survives; a cancellation is priced by the ladder and by nothing else. | Phase 1 shipped a typed exception for company-caused cancellations. It is withdrawn because the moment the system asks *who caused this*, it needs an answer it cannot verify and a policy for adjudicating it — and every such flag is a lever that quietly re-creates the ad-hoc pricing the engine replaced. A company that wants generous terms for its own failures expresses that in its ladder, where the terms are visible and apply to everyone equally. The cost is real and stated: there is no in-system way to make a weather cancellation whole beyond what the ladder says. |
| **D19** *(revised with D18a)* | **Consequence of D10 + D18a + D20 worth stating on its own: the selling agent forfeits their commission on an EARLY cancellation, and now does so on apartados too.** Beyond 120h the ladder refunds in full, retention is zero, and the D8 cap necessarily zeroes the kept commission. Inside 120h the agent keeps it. | Under the old flat default this applied to *every* cancellation; the graded ladder narrows it to the case where the company kept nothing either, which is the defensible version. What is new is the reach: the agent path used to hand over commission unconditionally (`clawback: false`, hard-coded), so an agent cancelling an apartado 5+ days out now **returns the deposit in full and keeps no commission**, where before they kept both. That is a change to what someone earns. It is on the record here so it is communicated to operations before release rather than discovered in a corte. |
| **D12** | **A tier carries two commission percentages: `agent_commission_pct` and `affiliate_commission_pct`.** Which one applies is decided by the seller's role, not by the folio. | An affiliate is a reseller, not staff — a company may well forgive its own agent a same-day cancellation while clawing back the reseller's cut. Both default to the same value in the settings UI, so a company that doesn't care never sees the distinction. Cheap now; expensive after policies exist in production with a one-percentage shape. |
| **D13** | **The agent's cancellation window is their current shift — everything up to their next confirmed cash drop.** Not a configurable number of hours. | The money is the boundary. While the cash is still in the agent's pocket, they can hand it back and their own balance absorbs it. Once the drop is confirmed the money is the company's and the balance is frozen (`balance_after` must never be rewritten — TECH_DEBT §12a). It needs no parameter, it can't be misconfigured, and it is *already* the line the cash engine draws. |
| **D14** | **The agent permission is a single org-level on/off switch, default OFF.** | US-A73 asks whether agents *may*, not which ones. Per-agent grants are a permissions system, and this feature is not that. Default OFF preserves the admin-only behaviour that has always applied. |
| **D16** *(original — superseded by D16a)* | ~~**The admin enters HOURS. There is no days field, and no days↔hours conversion in the UI.**~~ | The reasoning stands and is why D16a is conditional: "5 días" and "120 horas" are not the same promise, and the gap is where disputes live — a Friday 08:00 departure cancelled Sunday 18:00 IS five calendar days ahead but only 110 hours, so a days-labelled field can promise a refund the engine will not give. Where this went too far was the remedy: it banned the *input* to protect the *expectation*, and paid for it with mental arithmetic at configuration time (a five-day window entered as `120`). |
| **D16a** | **Hours remain the only STORED unit. The editor lets a tier be typed in hours or days, per tier, via a toggle — on three conditions:** (1) the exact hours are printed under the field in **both** modes, so the number the engine matches on is never hidden behind a friendlier unit; (2) toggling the unit is **value-preserving**, so inspecting a tier can never rewrite it; (3) a day amount that does not land on a whole hour is **rejected**, never silently rounded. | The expectation gap D16 guarded against is a *labelling* problem, not an arithmetic one — and it is fully closed by keeping the hours visible, which costs one line of read-back. Banning the input as well only moved the cost onto the admin: dividing by 24 in their head, every time, on a phone. A tier boundary is still exactly `min_hours` before the departure instant, and near-departure tiers are still expressible ("6 horas antes") because hours never stop being available. The rejection rule matters more than it looks: `1.3 días` is `31.2 h`, and quietly storing `31` would move a money boundary by an amount the admin never saw. |
| **D15** *(Phase 2 — superseded by D21)* | ~~**The auto-expiry sweep calls the same engine.**~~ | Written when the deposit floor still existed, so routing the sweep through the engine changed nothing about the money and only made the commission outcome explicit. With the floor gone (D20) it would change the money — it would refund deposits to customers who never came back to pay — so the decision is revisited rather than inherited. See D21. |
| **D20** | **An apartado is priced by the ladder, exactly like a fully-paid sale. The `booking_deposit_retained_pct` clause is DELETED, not defaulted to 0, and `folioStatus` is removed from the engine's inputs.** | The clause was a second rule for the same event, and it silently overrode the first: a ladder saying "se devuelve 100%" still returned nothing. Deleting it rather than zeroing it means no configuration can put the two back into contradiction. D3 already prices a partial payment correctly with no special case — retention is a share of the SALE, so a 30% deposit against a 50% retention leaves nothing to refund, and the customer is never pursued for the shortfall. Dropping `folioStatus` is the structural half: the engine literally cannot express a different answer for an apartado, so it cannot drift into one. |
| **D21** *(SUPERSEDED — `docs/bookings/apartado-stages.spec.md`)* | ~~**An apartado that EXPIRES refunds nothing, and the sweep deliberately does not call the engine.**~~ **The sweep WILL call the engine.** What changed is not the reasoning below but the instant it applies to: under the stage redesign the settle deadline stops cancelling — it notifies — and auto-cancellation moves to `salida − gracia` (15 min). At fifteen minutes out the ladder is always in its terminal tier, so the cron can no longer fire in a generous one whatever the admin configures. Routing the sweep through the engine becomes safe *by construction* rather than by coincidence of defaults, which is what both D21 and its rejected alternative were groping for. **Designed, not built** — the decision is settled, the code still does what D21 describes. |
| **D21 (original reasoning, kept)** | An apartado that expires refunds nothing. | Expiring is not cancelling with notice — the customer chose not to complete the deal, and the deposit is what a deposit is for. Two things make this concrete rather than convenient. First, `booking_expires_at` is now `departure − buffer` (the `createdAt + holdDays` cap was removed in `#30`; `holdDays` is retained inert), so an expiring apartado is always ~24h from departure, where the inherited ladder retains 50% of the sale — more than a typical deposit — and routing it through the engine would refund **$0 in nearly every case anyway**. The decision costs almost nothing today; it is written down so it stops being an accident. Second, refunding on expiry would make an apartado a free option on capacity, and would have a cron job minting refund obligations overnight for customers who ghosted. Residual, accepted: an org whose deposits exceed ~50% of the sale price gets a genuinely different answer from expiry than from a manual cancel at the same moment. |
| **D22** | **A REJECTED electronic payment (`rejectPayment`) also stays off the engine: full reversal, full clawback, no refund.** | The money never arrived. There is nothing to price and nothing to hand back, so a ladder has no opinion to offer — reversing the whole accrual and taking back the commission is the only coherent outcome. Recorded here only so that "it does not call the engine" reads as a decision rather than as the third thing somebody forgot. |

---

## Data Model

**No new tables.** Four additive columns.

### Migration `0053_cancellation_policy.sql` *(Phase 1)*

```sql
-- Org-level cancellation refund ladder (US-A69/A70/A72). NULL meant "no policy configured", which
-- in Phase 1 put every cancellation path on its pre-feature code. Phase 2 (0054) removes that
-- state: after the backfill, NULL is unreachable.
ALTER TABLE organizations ADD COLUMN cancellation_policy TEXT;

-- US-A73 (D14) — may an agent cancel their own current-shift sale? OFF preserves the admin-only
-- behaviour that has always been enforced by requireRole('admin') on the folios router.
ALTER TABLE organizations ADD COLUMN agent_cancellation_enabled INTEGER NOT NULL DEFAULT 0;

-- The ladder in force when the sale was confirmed (D6). NULL for folios sold before this feature;
-- those fall back to the org's live policy, which after 0054 always exists.
ALTER TABLE folios ADD COLUMN cancellation_policy_snapshot TEXT;

-- Who cancelled, as a TYPE rather than a prose reason. Previously the only way to tell a system
-- expiry from an admin action was `cancelled_by IS NULL` plus the Spanish string 'Apartado
-- vencido' — not something a report should have to parse. NULL = cancelled before this feature.
--   'admin' | 'agent' | 'tourist_request' | 'company' | 'system_expiry'
ALTER TABLE folios ADD COLUMN cancellation_source TEXT;
```

The `folios` columns are nullable and default-free — safe on a populated table, same shape as
`0013`'s `qr_token` and `0017`'s cancellation columns. `agent_cancellation_enabled` carries a
`0` default, matching how every other org toggle was added (`0028`, `0039`, `0052`).

> `'company'` remains in the `cancellation_source` enum but is **never written** after Phase 2
> (US-A71 withdrawn, D10). It is left in place rather than migrated away: a handful of folios
> cancelled during the Phase-1 window carry it, and rewriting historical audit rows to tidy an
> enum is a worse trade than an unused value.

### Migration `0054_cancellation_policy_default.sql` *(Phase 2 — D17/D18)*

```sql
-- Every organization gets an explicit ladder. After this, `cancellation_policy IS NULL` is not a
-- reachable state and the legacy pricing branches are dead code (deleted in the same PR).
--
-- The inherited default refunds everything, always (D18): one terminal tier. It is the reading a
-- customer would assume of an unstated policy, and it never refunds LESS than the most generous
-- path that existed before — so no customer is worse off on the day this lands.
--
-- Orgs with lodging cancel settings get this SAME default; those fields are deliberately NOT
-- translated (D18) — a stay policy would otherwise start governing that org's tours. They are
-- shown a banner in Settings telling them to reconfigure.
UPDATE organizations
SET cancellation_policy = json_object(
      'version', 1,
      'tiers', json_array(json_object(
        'min_hours', NULL,
        'refund_pct', 100,
        'agent_commission_pct', 0
      )),
      'booking_deposit_retained_pct', 100
    )
WHERE cancellation_policy IS NULL;
```

### Migration `0055_cancellation_policy_apartado.sql` *(Phase 3 — D18a/D20)*

Two data-only statements, no schema change.

1. **The inherited ladder is rewritten** from the flat 100% to the graded default (D18a) — but
   **only for orgs still carrying it**. The test is semantic, not textual, so it holds whether the
   document was written by `0054`'s `json_object()` or by the API's `JSON.stringify()` at
   organization creation:

   ```sql
   WHERE cancellation_policy IS NULL
      OR (json_array_length(cancellation_policy, '$.tiers') = 1
          AND json_extract(cancellation_policy, '$.tiers[0].min_hours') IS NULL
          AND json_extract(cancellation_policy, '$.tiers[0].refund_pct') = 100)
   ```

   An org that deliberately configured that same single tier is indistinguishable from the default
   — it is the same document — and is rewritten too. There is no way to tell those apart and no
   meaning in trying.

2. **`booking_deposit_retained_pct` is stripped** from every remaining document via `json_remove`.
   This is housekeeping, not a behaviour change: the Zod schema is a non-strict object, so a
   document still carrying the key already parses with the value ignored. It only stops the stored
   data from disagreeing with the schema when someone inspects it.

**Folio snapshots are deliberately not touched.** D6 — a folio is priced by the ladder in force when
it was sold, and rewriting a snapshot would retroactively change the terms of a completed sale.
Snapshots that still carry the deposit key simply stop honouring it, which *does* change how such a
folio prices; that is accepted because the engine never reached production, so no real folio was
ever sold under the floor.

The backfill alone is not enough — an org registered tomorrow would be born NULL. Two more
guards, both in code (D17):

1. **`createOrganization` writes the default** at registration, so a new org is never policy-less.
2. **`resolvePolicy` falls back to a module constant** when snapshot and org policy are both
   absent. This should be unreachable; it exists so that a missed row degrades to a defined,
   generous outcome instead of an unpriceable cancellation.

### The policy document

```json
{
  "version": 1,
  "tiers": [
    { "min_hours": 120,  "refund_pct": 100, "agent_commission_pct": 0,   "affiliate_commission_pct": 0   },
    { "min_hours": 0,    "refund_pct": 50,  "agent_commission_pct": 100, "affiliate_commission_pct": 50  },
    { "min_hours": null, "refund_pct": 0,   "agent_commission_pct": 100, "affiliate_commission_pct": 100 }
  ]
}
```

The ladder is the **whole** document. There is no deposit clause and no `folioStatus` input (D20):
an apartado is the same sale with less money collected against it, and the retention arithmetic
below already prices that.

| Field | Meaning |
|---|---|
| `tiers[].min_hours` | Matches when the line's departure is **at least** this many hours away. `null` is the terminal catch-all (a departure already past). |
| `tiers[].refund_pct` | 0–100. Share of that **line's total** the customer is entitled to. Retention is the complement. |
| `tiers[].agent_commission_pct` | 0–100. Share of that **line's commission** an **in-house agent** keeps, before the D8 cap. `0` = full clawback. |
| `tiers[].affiliate_commission_pct` | 0–100, **optional — defaults to `agent_commission_pct`** when omitted (US-A72, D12). Same meaning for a sale made by an affiliate reseller. |
| ~~`booking_deposit_retained_pct`~~ | **Removed in Phase 3 (D20).** It floored an unsettled `booking` folio's refund and, at its default of `100`, overrode every tier above it. A stored document may still carry the key; it is stripped on parse and ignored. |

The example above reads: *cancel with 5 days' notice and nobody earns anything; cancel same-day
and my own agent keeps their full commission while the reseller keeps half; a no-show pays
everyone in full, since the company kept 100%.*

**Which percentage applies** is decided by the **seller of the folio**, resolved once per folio,
not per line: a folio whose `agent_id` belongs to an affiliate company uses
`affiliate_commission_pct`; otherwise `agent_commission_pct`. Affiliate sales are already
distinguishable — an affiliate's commission rate comes from `affiliate_commissions`, and the
affiliate settlement (`affiliates/handler.ts:539`) already sums `folios.commission_amount` for
exactly this population.

**Validation** (Zod, in `organizations/schema.ts`):
- 1–10 tiers; each `refund_pct` / `agent_commission_pct` / `affiliate_commission_pct` an integer
  0–100.
- `min_hours` an integer ≥ 0, or `null`.
- **Exactly one** tier with `min_hours: null`, and it must sort last.
- `min_hours` values strictly descending and unique — no ambiguous or unreachable tier.
- The whole document is rejected as a unit; a malformed policy is never persisted, so a stored
  policy is always evaluable.
- A stored policy written **before** `affiliate_commission_pct` existed stays valid and behaves
  as it did — the field is optional and falls back (D12). Snapshots (D6) therefore never break.

---

## The computation

One **pure function**, `computeCancellationRefund` in `src/utils/cancellationPolicy.ts` — no
database, no clock of its own, fully unit-testable.

```
Inputs:  policy, lines[], amountPaid, folioStatus, nowEpoch, orgTimezone, sellerKind

# US-A72 / D12 — one lookup per folio, not per line.
commissionPctOf(tier) =
    sellerKind = 'affiliate'
      ? tier.affiliate_commission_pct ?? tier.agent_commission_pct
      : tier.agent_commission_pct

departureEpoch(line):
    lineType 'slot' → naiveEpoch(line.slot_date, line.slot_start_time, tz)
    lineType 'stay' → naiveEpoch(line.check_in, '00:00', tz)          # D11 below
    neither present → treated as already departed (terminal tier)

for each line:
    hoursOut   = (departureEpoch(line) − nowEpoch) / 3600
    tier       = first tier whose min_hours is not null and ≤ hoursOut,
                 else the terminal (min_hours: null) tier
    retention  = line.redeemed_count > 0                              # D7
                   ? line.line_total
                   : floor(line.line_total × (100 − tier.refund_pct) / 100)
    commission = line.commission_type = 'percent'
                   ? round(line.line_total × line.commission_value / 10000)
                   : line.commission_value × line.quantity
    kept       = min(floor(commission × commissionPctOf(tier) / 100), retention)       # D8 + D12

totalRetention  = Σ retention
totalCommission = Σ commission
keptCommission  = Σ kept

refund    = max(0, amountPaid − totalRetention)                       # D3 — and all of D20
retention = amountPaid − refund      # what was really kept, never more than was collected

Outputs: refund, retention, keptCommission, reversedCommission = totalCommission − keptCommission,
         and a per-line breakdown (line id, hoursOut, tier matched, retention) for the UI and audit.
```

**D11 — a stay's departure is its check-in at 00:00 org-local.** Lodging has no configurable
check-in hour today, and midnight is the conservative reading: the whole check-in day counts as
"same day". If a check-in time setting ever lands, this is the single line that changes.

**Rounding** is `floor` on retention (favours the customer) and `round` on commission (matches
`pos/handler.ts:1226`, so a cancellation never disagrees with the sale about what was earned).

**Commission is reconciled to `folios.commission_amount`, in both directions.** The per-line figures
above are derived from the line, but `folios.commission_amount` is what the cash engine and the
commission report actually read, so it wins:

- *lines carry nothing, folio booked something* — a folio sold before `0028` snapshotted commission
  onto lines. The booked amount is spread in proportion to `line_total`.
- *lines carry MORE than the folio booked* — **an apartado.** Commission accrues on the amount
  actually collected (US-AG07), so a 10% commission on a 300,000 sale with a 45,000 deposit booked
  4,500 while the lines, which describe the whole sale, still say 30,000.

Without this, an apartado's outcome reported 30,000 of forfeited commission — 6.7× reality. The
ledger was never at risk of paying it (`prorateAcrossBuckets` clamps a reversal to the commission
rows that exist), but the figure is shown to a human on the POS as *"esto es lo que pierdes"*.
`refund + totalRetention = amountPaid` holds by construction whenever `totalRetention ≤ amountPaid`.

### Worked example (the ladder above)

Folio: line A = tour tomorrow 08:00 (20h out), `line_total` 600, commission 60 · line B = tour in
8 days, `line_total` 400, commission 40. Customer paid 1000 in cash. Cancelled now.

```
line A → tier min_hours 0   → refund 50%  → retention 300 · kept commission min(60, 300) = 60
line B → tier min_hours 120 → refund 100% → retention   0 · kept commission min(0,    0) =  0

totalRetention = 300      refund = max(0, 1000 − 300) = 700
keptCommission =  60      reversedCommission = 100 − 60 = 40
```

Ledger writes `refund −700 cash` and `commission_reversal −40 cash`. Net live: **+300 revenue,
+60 agent commission**. The company earned 240 on a cancelled sale, and it is visible.

---

## Business Rules (enforced server-side)

1. **A policy always resolves (D17).**
   `resolvePolicy(folio) = parse(folio.cancellation_policy_snapshot) ?? parse(org.cancellation_policy) ?? DEFAULT_CANCELLATION_POLICY`.
   There is no null branch and no legacy path to fall back to — both were deleted. Every rule
   below applies to every cancellation, in every org.
2. **One computation, every caller.** `cancelFolio`, `approveCancellationRequest` and the
   read-only quote all price through `computeCancellationRefund`. The divergence documented in
   § Context cannot recur, because there is no longer a second implementation to diverge into.
3. **`refund_status`.** `refund > 0` → `'pending'`; `refund = 0` → `'none'` (nothing to hand back,
   so no refund PIN is minted and the confirm-refund flow never opens).
4. **The refund PIN follows the refund, not the path.** Any cancellation with `refund > 0` mints
   one — a tourist owed money must be able to prove presence at hand-back regardless of who
   pressed cancel.
5. **Commission (US-A70).** `cancellation_clawback` is set to `reversedCommission > 0`, preserving
   the column's meaning for every existing reader (the cash engine, the commission report). The
   *amount* reversed is `reversedCommission`, not necessarily the whole commission.
6. **No per-cancellation overrides exist (D10).** `clawback` and `cancelled_by_company` are
   **removed from the request schema**, not merely ignored — a client that sends either gets
   `400 VALIDATION_ERROR` rather than silently having it dropped. Failing loudly is the point:
   a silently-discarded money flag is how an admin comes to believe they made a decision that
   never took effect.
7. **The `0039` lodging cancel fields are retired.** `lodging_free_cancel_days` and
   `lodging_cancel_penalty_pct` are no longer read by anything, and their inputs are removed from
   Settings — a control that changes no behaviour is worse than a missing one. The columns stay
   for now; dropping them is a separate migration (the `0051` lesson: CI migrates before it
   deploys, so a column drop briefly outruns the old worker).
8. **Proportional ledger reversal.** `buildCancellationReversal` is always given `refundAmount`
   and `reversedCommission`; the reversal is prorated across the folio's positive method buckets
   in proportion to what each collected, with the largest bucket absorbing the rounding remainder
   so `Σ reversal = refundAmount` exactly. The parameters remain optional in the signature (they
   default to a full reversal) because the payment-reject path in POS still voids a folio outright
   — that is a void, not a policy-priced cancellation, and it should stay one.
   *Note:* under the inherited default the refund IS the whole amount, so the ledger rows are
   identical to the pre-engine behaviour. What changes on day one is `refund_status`, the PIN, and
   the commission reversal — not the money reversal.
9. **Retention is revenue, and it stays attributed.** The un-reversed remainder keeps its
   `collected_by`, so the selling agent's balance still shows the money they are holding. This is
   the point of the whole change: with a full reversal the retained cash exists physically in an
   agent's pocket and in no report.
10. **The snapshot is written once, at sale.** `confirmSale` (`pos/handler.ts:831`) copies
    `organizations.cancellation_policy` verbatim into `folios.cancellation_policy_snapshot`. It is
    never rewritten — not on settle, not on edit.
11. **Timezone.** Every hour computation uses `naiveEpoch(date, time, org.timezone)` (`utils/tz.ts`).
    No `toISOString()`, no calendar-date subtraction.
12. **Multitenancy.** Unchanged: org-scoped everywhere, `organization_id` / `status` /
    `cancelled_by` never read from a body. `refund_amount` is **never** client-supplied — and
    after D10 **no client input can move money at all**. The only thing a caller contributes to a
    cancellation is the optional free-text `reason`.
13. **`cancellation_source` is always set by the server**, from the route and the caller —
    never from a body. `admin` · `agent` (US-AG44) · `tourist_request` · `system_expiry` (the
    sweep). `company` is legacy-only (see § Data Model).
14. **No new `ErrorCode`.** `400 VALIDATION_ERROR` for a malformed policy document,
    `403 FORBIDDEN` for an agent cancelling outside their permission or window; everything else
    reuses the existing codes.

---

## Authorization — who may cancel

### Today

`/api/folios/*` is admin-only (`foliosRouter.use('*', authMiddleware, requireRole('admin'))`).
An agent has no cancellation path at all — a customer who changes their mind thirty seconds
after paying has to find an admin.

### US-A73 / US-AG44 — the agent's current shift

15. **Off by default (D14).** With `agent_cancellation_enabled = 0` — every existing org — the
    new endpoint returns `403 FORBIDDEN` for everyone. Nothing changes.
16. **The window is the shift, not a clock (D13).** An agent may cancel a folio only while
    **every one of its `folio_payments` rows is strictly after their `settlementWatermark`** (the
    instant of their most recent confirmed cash drop; `null` = they have never dropped, so
    everything qualifies). The money must still be in their hands.
    - This is deliberately stricter than "the folio was created this shift": a booking whose
      deposit was collected last week and settled today has a *pre-watermark* payment row, so the
      agent cannot cancel it. Part of that money is already the company's.
    - It also makes the reversal safe by construction. A confirmed drop freezes `balance_after`,
      which must never be rewritten (TECH_DEBT §12a); a cancellation confined to the current shift
      can never touch a frozen figure.
    - `settlementWatermark` is currently a private `const` in `cash/handler.ts:296`. It moves to
      `src/utils/cashWatermark.ts` unchanged and both call sites import it — a pure move, no
      behaviour change.
17. **Only their own sales.** `folios.agent_id = caller.userId`. An agent never sees, let alone
    cancels, another agent's folio.
18. **Nothing redeemed.** Any line with `redeemed_count > 0` → `403 FORBIDDEN`. A delivered
    service is an admin conversation, and it also keeps D7's 100%-retention rule out of the
    agent's hands.
19. **The agent executes the policy, they do not set it.** The ladder computes the refund exactly
    as it would for an admin. The agent **cannot** pass `cancelled_by_company` (US-A71 is
    admin-only — it is the escape from the policy, so it cannot belong to the person the policy
    constrains) and **cannot** pass `clawback`. Both are rejected, not ignored, so a mistaken
    client fails loudly.
20. **The agent hands the money back from their own drawer.** The refund reverses against their
    own balance (Rule 9 attribution), which is where the cash physically is. `refund_status` and
    the PIN follow Rules 3 & 4 unchanged.
21. **A cancelled folio is not re-cancellable and not re-openable.** Unchanged: `409 CONFLICT`.
    An agent who cancels by mistake needs an admin — there is no un-cancel in this system.

### US-A74 — the system's own cancellations *(D21 — the sweep deliberately does NOT run the engine)*

22. **An expired apartado refunds nothing, by decision.** `sweepExpiredBookings`
    (`routes/pos/sweep.ts`, cron `*/15 * * * *`) cancels the folio, releases the seats and zones,
    writes `cancellation_source = 'system_expiry'` / `cancelled_by = null`, retains the deposit, and
    writes **no** `folio_payments` rows. Expiring is not cancelling with notice: the customer chose
    not to complete the deal, and the deposit is what a deposit is for. See D21 for why routing it
    through the engine was rejected — chiefly that `booking_expires_at` is now `departure − buffer`,
    so an expiring apartado is always ~24h out where the ladder retains more than a typical deposit
    anyway, and that refunding on expiry would make an apartado a free option on capacity.
22b. **The residual is accepted and stated.** An org whose deposits exceed ~50% of the sale price
    gets a different answer from expiry than from a manual cancel at the same moment. Revisit if a
    company actually runs deposits that large.
23. **The sweep must not become slow or unbounded.** It loops folio-by-folio with a batch each and
    adds no per-folio query. Unchanged by Phase 3 — this is one reason keeping it off the engine is
    cheap.
24. **The sweep stays fail-soft.** It runs under `waitUntil` with a `.catch`. A folio whose policy
    fails to parse is **skipped and logged**, never left half-cancelled, and never aborts the
    sweep for the other folios.

---

## Endpoints

### `PATCH /api/organizations/current` — configure the ladder (US-A69, A70, A72, A73)

Existing endpoint, two new optional fields. `cancellation_policy: null` clears the column; there is
no legacy path left to return to (D17), so the org simply falls back to the inherited ladder —
which is why the Settings card writes the default explicitly instead of clearing.

```json
{
  "cancellation_policy": {
    "version": 1,
    "tiers": [
      { "min_hours": 120,  "refund_pct": 100, "agent_commission_pct": 0,   "affiliate_commission_pct": 0   },
      { "min_hours": 0,    "refund_pct": 50,  "agent_commission_pct": 100, "affiliate_commission_pct": 50  },
      { "min_hours": null, "refund_pct": 0,   "agent_commission_pct": 100, "affiliate_commission_pct": 100 }
    ]
  },
  "agent_cancellation_enabled": true
}
```

A body still carrying `booking_deposit_retained_pct` — a stale client build — is **accepted**, with
the key stripped. Rejecting it would lock someone out of editing their own ladder from an open tab.

### `GET /api/folios/:id` — folio detail

Gains a `cancellation_quote` block on a **cancellable** folio: what would happen if it were
cancelled right now. Pure read, computes nothing persistent — it is what the confirm sheet shows.

```json
{
  "cancellation_quote": {
    "refund": 700,
    "retention": 300,
    "kept_commission": 60,
    "reversed_commission": 40,
    "lines": [
      { "line_id": "fl_a", "hours_out": 20,  "refund_pct": 50,  "retention": 300 },
      { "line_id": "fl_b", "hours_out": 192, "refund_pct": 100, "retention": 0   }
    ]
  }
}
```

`null` only when the folio is already cancelled or is otherwise not cancellable. Every live folio
quotes, because every org has a policy.

### `POST /api/folios/:id/cancel` — cancel (US-A21)

```json
{ "reason": "El cliente no llegó" }
```

**`reason` is the only accepted field.** `clawback`, `cancelled_by_company` and `refund_amount`
are rejected with `400 VALIDATION_ERROR` (Rule 6) — not stripped, not ignored. Sets
`cancellation_source = 'admin'`. Response adds the realised numbers alongside the folio payload:
`refund`, `retention`, `kept_commission`, `reversed_commission`.

### `POST /api/pos/folios/:id/cancel` — agent cancels an apartado (US-AG07.4, priced since Phase 3)

Agent-scoped, mounted on the POS router alongside the existing agent receipt read
(`GET /api/pos/folios/:id`) so the admin-only guard on `/api/folios/*` stays intact.

**This route already existed.** Today it is **booking-only** (`409 NOT_A_BOOKING` for anything
else), owner-or-admin scoped, and **not** gated by `agent_cancellation_enabled` — that gate and the
shift rules below (15–21) belong to **US-AG44**, which widens this route to paid sales and is still
deferred. What Phase 3 changed is that the route no longer prices cancellations itself: it calls
`cancelFolioPriced`, the same commit the admin path uses, and returns the realised outcome.

```json
{ "reason": "El cliente cambió de opinión" }
```

`reason` optional. No other field is accepted — same strictness as the admin route (Rule 6).

Sets `cancellation_source = 'agent'`, `cancelled_by = caller.userId`. Returns the same shape as
the admin cancel.

| Status | Condition |
|---|---|
| `403 FORBIDDEN` | `agent_cancellation_enabled = 0`, or the folio is not theirs, or a payment predates their watermark, or a line is redeemed |
| `404 NOT_FOUND` | Unknown or cross-org folio (checked before the ownership rules, so a 403 never confirms a folio exists elsewhere) |
| `409 CONFLICT` | Already cancelled |

### `GET /api/pos/folios/:id` — agent receipt read

Gains the same `cancellation_quote` block, plus `can_cancel: boolean` — so the POS can show or
hide the button without the agent discovering the answer by pressing it. `can_cancel` evaluates
Rules 15–18 and is the single source of truth for both the UI and the endpoint.

### `POST /api/folios/cancellation-requests/:requestId/approve` — approve a tourist request

Same computation, same response additions. Takes **no body fields at all** — approving is not a
pricing decision, it is an authorisation. Sets `cancellation_source = 'tourist_request'`.

---

## Error responses

| Status | Code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed policy: bad percentages, zero or multiple terminal tiers, non-descending `min_hours`, more than 10 tiers |
| 400 | `VALIDATION_ERROR` | Malformed cancel body (non-boolean `cancelled_by_company`) |
| 400 | `VALIDATION_ERROR` | An agent sent `cancelled_by_company`, `clawback` or `refund_amount` (Rule 19) |
| 403 | `FORBIDDEN` | Caller is not an admin (admin routes) |
| 403 | `FORBIDDEN` | Agent cancellation disabled for the org (US-A73) |
| 403 | `FORBIDDEN` | Agent cancelling a folio that is not theirs, or with a payment at/before their settlement watermark, or with a redeemed line |
| 404 | `NOT_FOUND` | Folio unknown or in another org |
| 409 | `CONFLICT` | Folio already cancelled |

---

## Scenarios

### US-A69 — the ladder

#### Scenario 1 — The example, end to end
**Given** an org with the ladder above and a **paid** tour folio of 1000 fully paid in cash, whose
single line departs in 6 days
**When** the admin cancels it
**Then** `refund_amount = 1000`, retention 0, and the ledger holds `refund −1000 cash` — a full
refund. Cancelling an identical folio departing **in 3 hours** yields `refund_amount = 500`,
retention 500, ledger `refund −500 cash`, and 500 remains live in the agent's balance. Cancelling
one whose departure was **yesterday** yields `refund_amount = 0`, `refund_status = 'none'`, and
**no** `refund` row at all.

#### Scenario 2 — Per-line evaluation (D4)
**Given** the two-line folio of the worked example (600 at 20h, 400 at 8 days), 1000 paid
**When** the admin cancels
**Then** `refund_amount = 700`, `cancellation_retention = 300`; the quote's `lines` array reports
tier 50% for line A and 100% for line B.

#### Scenario 3 — A redeemed line retains everything (D7)
**Given** a 2-day package, line A (500) already scanned (`redeemed_count = 1`), line B (500)
departing in 20 hours, 1000 paid, ladder as above
**When** the admin cancels
**Then** retention = 500 (line A, full) + 250 (line B, 50%) = 750; `refund_amount = 250`.

#### Scenario 4 — An apartado is priced by the ladder (D20)
*Replaces "Deposit floor on a booking (US-AG07.4 preserved)", which asserted the opposite: a floor
pinned the refund to 0 whatever the ladder said.*

**Given** a `booking` folio of 1000 with a 300 deposit paid, departing in 6 days (a 100%-refund
tier)
**When** the admin — or the selling agent, from the POS — cancels
**Then** `refund_amount = 300`: retention is 0, so every peso collected goes back.
**And** `refund_status = 'pending'` with a PIN minted, because money is owed and the customer must
be able to prove they were present to collect it (Rules 3 & 4 — the obligation follows the money,
not the path).

**And given** the same folio departing in 20 hours instead (a 50% tier)
**Then** `refund_amount = 0` — the ladder retains 500 of the 1000 sale and only 300 was ever
collected, so nothing is left over. **No deposit rule is involved in either answer**, and the
customer is never pursued for the 200 shortfall.

#### Scenario 5 — Retention above what was collected never goes negative (D3)
**Given** a `paid` folio, total 1000, only 300 collected, cancelled same-day (50% retention = 500)
**When** the admin cancels
**Then** `refund_amount = 0` (not −200); retention is capped at 300 in the ledger — the customer
is not pursued for the shortfall.

#### Scenario 6 — Timezone and time-distance (D5)
**Given** an org in `America/Mexico_City` and a slot at 06:00 tomorrow local, cancelled at 23:00
today local — calendar-tomorrow, but 7 hours away
**When** the admin cancels
**Then** the **same-day** tier (`min_hours: 0`) matches, not the 120h tier. Asserted against the
current UTC-date implementation, which would match the wrong tier.

### US-A70 — commission

#### Scenario 7 — Per-tier commission retention
**Given** the worked-example folio (commission 60 + 40)
**When** it is cancelled
**Then** the agent keeps 60, the ledger holds `commission_reversal −40`, and
`cancellation_clawback = true` (something was reversed).
**And** with `agent_commission_pct: 100` on every tier nothing is reversed and
`cancellation_clawback = false`.

#### Scenario 8 — Kept commission is capped by retention (D8)
**Given** a tier with `refund_pct: 100` and `agent_commission_pct: 100`, a folio of 1000 fully
paid with commission 100
**When** it is cancelled
**Then** retention 0 → kept commission `min(100, 0) = 0`; the full commission is reversed. The
company refunds 1000 and pays 0 — it never ends a cancellation out of pocket.

### D10 — the ladder is the only thing that prices

#### Scenario 9 — No caller can override the computation
**Given** a folio departing in 3 hours (a 50% tier)
**When** the admin cancels with `{ "cancelled_by_company": true }`, or `{ "clawback": false }`, or
`{ "refund_amount": 999999 }`
**Then** `400 VALIDATION_ERROR` in every case, and the folio is **untouched** — not cancelled
with the flag ignored. Cancelling with only a `reason` succeeds and refunds exactly what the
ladder says.

### D17/D18 — the universal default

#### Scenario 10 — An org that never configured anything still prices coherently
**Given** an org that has never opened the cancellation settings, and a paid tour folio of 1000
**When** the admin cancels it, and separately an identical folio is cancelled via an approved
tourist request
**Then** **both** refund 1000, both set `refund_status = 'pending'`, both mint a PIN, and both
reverse the ledger in full. The Phase-1 divergence (0 vs 1000 depending on the path) is gone even
for orgs that configured nothing. *(This scenario is the whole point of Phase 2.)*

#### Scenario 11 — The default is visible, not implicit
**Given** any organization, including a brand-new one just registered
**When** the admin opens Settings, or `GET /api/organizations/me`
**Then** `cancellation_policy` is a real ladder they can read and edit — never `null`, and never a
banner saying they have no policy while the system silently applies one.

#### Scenario 12 — An org with lodging cancel settings gets the default, plus a warning
**Given** an org with `lodging_cancel_penalty_pct = 20` before the migration
**When** the migration runs
**Then** its policy is the standard 100% default — **not** a ladder translated from those fields
(D18) — and Settings shows a banner telling them their lodging cancellation terms were superseded
and to configure a ladder. Their tours are not silently governed by a stay policy.

#### Scenario 13 — A missed row still prices
**Given** an org whose `cancellation_policy` is somehow `NULL` (a row the backfill missed)
**When** a folio of theirs is cancelled
**Then** `resolvePolicy` falls back to the module constant and the cancellation is priced at 100%
— never an unpriceable folio, never a 500.

### Snapshot (D6)

#### Scenario 14 — Editing the policy does not re-price an existing sale
**Given** a folio sold under a 100%/50%/0% ladder
**When** the admin changes the org policy to 0% everywhere, then cancels that folio same-day
**Then** the refund is computed from the **snapshot** — 50%, not 0%.

#### Scenario 15 — A folio sold before this feature falls back to live
**Given** a folio with `cancellation_policy_snapshot = NULL` in an org that has since configured
a ladder
**When** it is cancelled
**Then** the org's **current** policy is applied (there is nothing else to apply), and this is
stated in the settings UI where the ladder is edited.

### Ledger (Rule 8)

#### Scenario 16 — Proportional reversal across methods
**Given** a folio paid 300 cash + 700 transfer, cancelled with `refund_amount = 500`
**When** the reversal is written
**Then** two rows: `refund −150 cash` and `refund −350 transfer`; `Σ reversal = −500` exactly, and
each method's live bucket stays non-negative.

#### Scenario 17 — Rounding remainder lands in the largest bucket
**Given** a folio paid 333 cash + 667 transfer, `refund_amount = 500`
**When** the reversal is written
**Then** the two rows sum to exactly −500 (no lost or invented unit), with the remainder absorbed
by the transfer bucket.

#### Scenario 18 — Retained money stays in the agent's balance
**Given** agent Ana holding a paid cash folio of 1000, cancelled with 300 retained
**When** `GET /api/cash/me`
**Then** Ana's `cash_collected` includes **300**, not 0 and not 1000 — she is still holding the
retained cash and the corte asks for it.

### US-A72 — affiliate commission split (D12)

#### Scenario 19 — The same tier pays an agent and a reseller differently
**Given** a tier `{ refund_pct: 50, agent_commission_pct: 100, affiliate_commission_pct: 50 }` and
two identical same-day folios of 1000 with commission 100 — one sold by an in-house agent, one by
an affiliate
**When** both are cancelled
**Then** the in-house agent keeps 100 (nothing reversed, `cancellation_clawback = false`); the
affiliate keeps 50 and `commission_reversal −50` is written. Both refunds are 500 — the split
touches commission only, never the customer's money.

#### Scenario 20 — Omitting the affiliate percentage falls back
**Given** a tier with `agent_commission_pct: 0` and **no** `affiliate_commission_pct`
**When** an affiliate's folio is cancelled under it
**Then** the affiliate is treated exactly like an in-house agent — 0% kept, full reversal. A
policy written before US-A72 keeps behaving as it did, including one already snapshotted onto a
folio (D6).

#### Scenario 21 — The D8 cap applies to affiliates too
**Given** a tier with `refund_pct: 100` and `affiliate_commission_pct: 100`
**When** an affiliate's folio is cancelled under it
**Then** retention 0 → the affiliate keeps 0. The cap is a property of the engine, not of the
seller's role.

### US-A73 / US-AG44 — agent cancels their own shift sale

#### Scenario 22 — Disabled by default
**Given** an org that has never touched the setting (`agent_cancellation_enabled = 0`)
**When** an agent calls `POST /api/pos/folios/:id/cancel` on their own folio, sold one minute ago
**Then** `403 FORBIDDEN`; nothing changes. **And** `GET /api/pos/folios/:id` reports
`can_cancel: false`.

#### Scenario 23 — Enabled: the agent cancels and hands the money back
**Given** `agent_cancellation_enabled = 1`, agent Ana with **no** confirmed drop yet, and her own
paid cash folio of 1000 departing in 6 days (100%-refund tier)
**When** Ana cancels it
**Then** `200`; `refund_amount = 1000`, `cancellation_source = 'agent'`,
`cancelled_by = <Ana's id>`; the seats are released; the ledger holds `refund −1000 cash` against
**Ana's** balance, so her `cash_collected` drops by 1000 — she handed the cash back.

#### Scenario 24 — The window closes at the confirmed drop (D13)
**Given** Ana sells a folio, then her cash drop is **confirmed**
**When** Ana cancels that folio
**Then** `403 FORBIDDEN` — its payment row is at/before her settlement watermark. The admin path
still works and behaves normally.

#### Scenario 25 — A settled booking is not the agent's to cancel
**Given** a booking whose **deposit** was collected last week (before Ana's last confirmed drop)
and whose **balance** Ana settled this shift
**When** Ana cancels it
**Then** `403 FORBIDDEN` — the rule is *every* payment row after the watermark, not the most
recent one. Part of that money already belongs to the company.

#### Scenario 26 — Not their folio, and redeemed lines
**Given** `agent_cancellation_enabled = 1`
**When** Ana cancels a folio sold by Beto, and separately her own folio with `redeemed_count = 1`
on a line
**Then** `403 FORBIDDEN` in both cases; nothing changes.

#### Scenario 27 — The agent cannot escape the policy
**Given** `agent_cancellation_enabled = 1` and a same-day folio (50% tier)
**When** Ana cancels with `{ "cancelled_by_company": true }` — or with `{ "clawback": false }`, or
`{ "refund_amount": 1000 }`
**Then** `400 VALIDATION_ERROR` in every case (Rule 19). Cancelling with only a `reason` succeeds
and refunds 500 — the ladder, not Ana.

#### Scenario 28 — A cross-org folio 404s before it 403s
**Given** `agent_cancellation_enabled = 1` in `org_a`
**When** the `org_a` agent cancels an `org_b` folio by id
**Then** `404 NOT_FOUND` — never `403`, which would confirm the folio exists somewhere.

### US-A74 — auto-expired bookings (D21)

#### Scenario 29 — An expired apartado refunds nothing, whatever the ladder says
**Given** an org with any ladder — including one whose top tier refunds 100% — and a booking past
`booking_expires_at` with a 300 deposit and 30 commission
**When** the cron sweep runs
**Then** the folio is `cancelled` with `cancelled_by = null`, reason *"Apartado vencido"*, the seats
and zones are released, **no** `folio_payments` rows are written, the agent keeps the 30, and
`cancellation_source = 'system_expiry'`.

#### Scenario 30 — Expiry and a manual cancel agree in practice
**Given** an apartado whose deposit is ≤50% of the sale, expiring at `departure − 24h`
**When** the sweep runs, and separately when an agent cancels it by hand at that same moment
**Then** both produce `refund_amount = 0` — the sweep by D21, the manual path because the ladder's
24h tier retains 50% of the sale, which already exceeds the deposit. *(This is why D21 costs almost
nothing; the paths only diverge for deposits above the retained share.)*

#### Scenario 31 — A rejected electronic payment is not a priced cancellation (D22)
**Given** a folio awaiting transfer verification, which the admin rejects
**When** `rejectPayment` runs
**Then** the folio is `cancelled` with `refund_status = 'none'`, the accrual is reversed in full and
`cancellation_clawback = true` — the money never arrived, so there is nothing for a ladder to price.

#### Scenario 32 — A broken policy skips one folio, not the sweep
**Given** two expired bookings, one whose snapshot fails to parse
**When** the sweep runs
**Then** the healthy folio is cancelled normally, the broken one is left `booking` and logged, and
the sweep returns having processed the rest (Rule 24).

### Multitenancy (required — `seedTwoOrgs`)

#### Scenario 33 — B3/B4: policies do not leak across orgs
**Given** `org_a` with a ladder and `org_b` with none
**When** an `org_a` admin cancels an `org_b` folio by id
**Then** `404 NOT_FOUND`; the `org_b` folio is untouched.
**And** cancelling an `org_b` folio as an `org_b` admin uses **no** policy — `org_a`'s ladder is
never consulted.

#### Scenario 34 — B1: injected money fields are ignored
**Given** an `org_a` admin cancelling with a body containing
`{"refund_amount": 999999, "cancellation_retention": 0, "organizationId": "org_b"}`
**Then** the persisted `refund_amount` is the **computed** one and the org is unchanged — Zod
strips the unknown keys before the handler sees them.

---

## Definition of Done

- [ ] Migration `0053_cancellation_policy.sql` — `organizations.cancellation_policy` and
      `folios.cancellation_policy_snapshot`, both nullable, no backfill
- [ ] Drizzle schema updated; types infer
- [ ] `src/utils/cancellationPolicy.ts` — the policy Zod schema, `resolvePolicy`, and the pure
      `computeCancellationRefund`, with a dedicated unit-test file covering the algorithm
      (tier matching, redeemed lines, deposit floor, D3 clamp, D8 cap, rounding)
- [ ] `updateOrganizationSchema` accepts `cancellation_policy` (object or `null`, incl.
      `affiliate_commission_pct`) and `agent_cancellation_enabled`, with the full validation of
      § Data Model; `GET /api/organizations/current` returns both
- [ ] `confirmSale` (`pos/handler.ts:831`) writes the snapshot (Rule 10)
- [ ] `buildCancellationReversal` takes an optional `refundAmount` + `reversedCommission` and
      prorates; **omitting them reproduces the current full reversal byte for byte** (Rule 8)
- [ ] `cancelFolio` and `approveCancellationRequest` price through the engine unconditionally;
      `refund_status` and the PIN follow Rules 3 & 4; `cancellation_source` set on every path

### Phase 2 — the universal default (D17/D18)

- [ ] Migration `0054_cancellation_policy_default.sql` backfills every `NULL` policy
- [ ] `createOrganization` writes the default for new orgs; `resolvePolicy` falls back to the
      module constant — the two guards that make "no policy" unreachable rather than merely rare
- [ ] **Deleted, not bypassed:** the `0039` lodging branch in `cancelFolio`, the blind full-refund
      fallback in `approveCancellationRequest`, and the `clawback` / `cancelled_by_company` fields
      from the cancel schemas + handlers + UI
- [ ] The lodging "Cancelación gratuita" / "Penalización" inputs removed from Settings, with a
      one-time banner for orgs that had them set (Scenario 12)
- [ ] `docs/lodging/accommodation-stays.spec.md` (D9 + §2.5), `total-folio-cancellation.spec.md`
      (US-A26) and `tourist-self-service-portal.spec.md` (the refund amount) updated to match
- [ ] `settlementWatermark` moved from `cash/handler.ts:296` to `src/utils/cashWatermark.ts`
      unchanged, imported by both call sites (pure move — the cash suite must stay green)
- [ ] **NEW** `POST /api/pos/folios/:id/cancel` — agent-scoped, gated by
      `agent_cancellation_enabled`, enforcing Rules 15–21; strict body (Rule 19)
- [ ] `GET /api/folios/:id` and `GET /api/pos/folios/:id` return `cancellation_quote`;
      the POS read also returns `can_cancel`, computed from the same predicate the endpoint uses
- [ ] ~~`sweepExpiredBookings` routed through the engine~~ — **withdrawn in Phase 3 (D21).** The
      sweep keeps its own behaviour, now as a written rule rather than an accident
- [ ] Scenarios 1–34 covered by the `test/cancellation/` suites (+ agent-permission and sweep
      cases), with the ledger assertions alongside the paid-ledger suite
- [ ] **`folio-cancellation.test.ts` and `agent-balance-cash-drops.test.ts` are UPDATED, not
      preserved.** Phase 1's "these pass unedited" criterion is retired with the gate that made it
      possible. Its replacement is weaker but still binding: **every edited assertion must be
      justified by a rule in this spec, cited in the PR.** An edit that only makes red go green is
      a defect being papered over — the failure mode this criterion exists to catch
- [ ] Frontend: a **Política de cancelación** section in admin settings (ladder editor with a live
      preview — "cancelando ahora un folio de $1,000 → se devuelve $X" — the affiliate column
      collapsed behind a *"¿Los afiliados tienen otra regla?"* toggle so a company that doesn't
      care never sees it, and the **agent cancellation** switch); the computed refund shown in the
      cancel `ConfirmSheet` with its per-line breakdown — and **no switches at all** in that
      dialog, since nothing about a cancellation is a per-case decision any more (D10);
      a **Cancelar venta** action in the POS receipt, rendered only when `can_cancel`
- [ ] **Only HOURS are stored (D16a).** A tier may be typed in hours or days via a per-tier
      toggle, provided the exact hours are shown in both modes, toggling preserves the value, and
      a fractional-hour day amount is rejected rather than rounded.
- [ ] `pnpm --filter api-turistear test` green; `pnpm build:app` clean
- [ ] `docs/SPEC.md` updated with US-A69–A74 and US-AG44

### Phase 3 — the apartado (D18a/D20/D21/D22)

- [x] `booking_deposit_retained_pct` removed from the Zod schema; a stored document still carrying
      it parses with the key stripped (no version bump, no snapshot rewrite)
- [x] `folioStatus` removed from `ComputeRefundInput` — the engine cannot distinguish an apartado
- [x] `DEFAULT_CANCELLATION_POLICY` is the graded ladder (D18a), in the API **and** the client copy
- [x] Migration `0055_cancellation_policy_apartado.sql` — rewrites only orgs still on the 0054
      default (semantic match, verified against the three cases: old default → rewritten,
      configured → untouched, `NULL` → rewritten), then strips the retired key from the rest
- [x] `cancelFolioPriced` extracted; **all three** entrances call it — admin, tourist-request
      approval, and the agent apartado cancel. The agent path's hard-coded `refund_status: 'none'`,
      `clawback: false` and full ledger reversal are gone, along with its missing race guard and
      its unclamped seat decrement
- [x] `lineCommissions` reconciles to `folios.commission_amount` in both directions, so an
      apartado's reported forfeited commission is what actually accrued, not what the whole sale
      would have earned
- [x] `POST /api/pos/folios/:id/cancel` returns the realised `cancellation` outcome so the POS can
      state the refund instead of asserting *"no es reembolsable"*
- [x] Suite green — **652 tests, 50 files**. Every edited assertion justified by a rule here;
      three (`accommodation-stays` Sc12, `cash-engine-ledger`, `folio-cancellation` Sc6b) were
      **rebuilt rather than renumbered**, because the new default would otherwise have made them
      pass while no longer discriminating
- [ ] POS: the cancellation quote on the folio detail and in the confirm dialog (#12/#13)
- [ ] Operations told about D19's reach before release — an agent cancelling an apartado 5+ days
      out now returns the deposit in full and keeps no commission, where before they kept both

---

## Deferred — and why each is safe to defer

| Deferred | Why it holds | What lands it later |
|---|---|---|
| **`refund_obligations` table** — the refund as a first-class obligation with its own lifecycle | The seven scalar columns of `0029` carry one refund per folio, which is all a single cancellation produces today | Needed the moment you want partial hand-backs, a later exception adjusting an already-computed refund, or a record of *which drawer* the money left |
| **Moving the ledger reversal to the physical hand-back** (reopening paid-ledger D6) | With proportional reversal the discrepancy shrinks to the refunded portion and lasts only until hand-back. It is a reporting inaccuracy, not lost money | Land it together with `refund_obligations`, since that table is what makes the pending amount visible |
| **Choosing the refund method at hand-back** | Proportional prorating is correct by default and never leaves a method bucket negative | A `method` field on `confirmRefund` — but only once the reversal is written at hand-back, otherwise the row exists before the choice does |
| **Per-service / per-category policy override** | The column is org-level; `resolvePolicy` is a single function and already the only place resolution happens | Add `services.cancellation_policy_id` and a resolution chain inside `resolvePolicy`. The snapshot (D6) already protects history through the change |
| **Bulk-cancelling a whole slot** (weather cancels a departure, not a folio) | US-A71 makes the per-folio outcome correct; the pain is repetition, not correctness | `POST /api/schedules/slots/:id/cancel` fanning out with `cancelled_by_company: true`. Note it collides with the "no partial cancellation" rule for multi-service folios |
| **Retiring `lodging_free_cancel_days` / `lodging_cancel_penalty_pct` (`0039`)** | They still drive stays for orgs without a ladder; an org that configures one supersedes them (Rule 1) | See § Known behaviour change |
| **Per-agent cancellation permission** (trusted agents may, new hires may not) | US-A73 asks *whether*, not *which* — and the shift window (D13) already bounds the blast radius to money the agent is physically holding | A real permissions layer. Do not grow it as a second boolean on `users`; it belongs with roles |
| **Un-cancelling / reopening a folio** | There is no un-cancel in this system today, for anyone (Rule 21) | Out of scope entirely — it would have to reverse the reversal *and* re-take the seats, which may be gone |
| **Notifying the customer that the system expired their booking** | The sweep sends nothing today either | The same email seam `cancelFolio` already leaves for US-C03 |

---

## Rollout — what changes for existing organizations

Phase 2 changes behaviour for **every** org on the day it deploys. Nothing here is a surprise to
be discovered in production; all of it should be in the release note.

| What changes | Who feels it | Why |
|---|---|---|
| An admin cancelling a paid tour now records a **refund obligation** (`pending` + PIN) where it recorded nothing | Admins, daily | The money was collected and the sale is cancelled — the obligation was always real, it just was not tracked. The refund queue gets busier, and that work is honest work |
| The selling **agent forfeits their commission** on every cancellation under the inherited default | Agents, immediately | D19. Retention is 0 under a 100% refund, so the D8 cap zeroes the kept commission. Previously an admin could absorb it. **Mitigation: configure a ladder with retention** — any tier that keeps money can pay commission from it |
| A tourist-approved cancellation refunds what the **ladder** says, not `amount_paid` blindly | Tourists, on request | Under the inherited default these coincide (both 100%), so nothing visibly changes until an org configures retention |
| **Lodging cancel terms stop applying.** `lodging_free_cancel_days` / `lodging_cancel_penalty_pct` are no longer read | Lodging orgs | D18 — those fields are not translated, because a stay policy would then govern tours too. They get a Settings banner and must configure a ladder to restore penalties |
| The `clawback` and `cancelled_by_company` request fields now **400** instead of being accepted | API clients | Rule 6. A silently-dropped money flag is worse than a rejected one |

> ⚠️ **The two claims above about the inherited default no longer hold — see Phase 3 below.** They
> were written when that default refunded 100% unconditionally. Under D18a it is a graded ladder, so
> a cancellation inside 120h retains money, and money reversal is *not* unchanged on day one.

### Phase 3 — the apartado (D18a/D20/D21)

| What changes | Who feels it | Why |
|---|---|---|
| **An agent cancelling an apartado 5+ days out now returns the deposit in full and keeps no commission** | Agents, immediately | D19 + D20. Before, that button retained the deposit and paid full commission, both hard-coded. This is a change to what someone earns and is the single item that must reach operations **before** release, not after |
| A cancellation inside 120h now **retains money**, so the ledger reversal is partial | Cortes, daily | The retained amount stays on the books as money the company is owed. Under the old flat default everything reversed to zero — which, on the agent apartado path, meant a retained deposit vanished from the books entirely while the cash sat in a drawer |
| A no-show no longer gets a full refund | Tourists | The inherited ladder's terminal tier refunds 0% |
| An expired apartado still refunds nothing | Nobody — unchanged | D21, now a written rule rather than handler behaviour |

**Production exposure is one organization**, and the graded default matches the terms it already
operates under — which is what makes shipping the default change (rather than a per-org migration
with a grace period) proportionate. The engine has never reached `main`, so **no real folio carries
a snapshot** and no customer was ever promised the flat 100%.

### The lodging under-clamp, now fixed for everyone

The retired lodging path never clamped its refund to what was collected:

```
old  refund = floor(stay_total × (100 − penalty_pct) / 100)      # no clamp to amount_paid
new  refund = max(0, amount_paid − retention)                    # clamped by construction
```

A stay sold with a 30% deposit and cancelled inside the penalty window could produce a
`refund_amount` larger than the customer ever paid. That is now impossible — but note that under
the inherited default those stays refund 100% of what was *paid*, which for a deposit-only stay is
the deposit. Lodging orgs that want a penalty must configure one.

### Suggested sequence

1. Deploy to **dev**; verify a cancellation in each shape (tour, stay, apartado from BOTH the admin
   folio detail and the agent's POS button, tourist request).
2. **Tell operations about the agent commission change** (D19) — the one item that lands on a
   person's pay rather than on a report.
3. Notify lodging orgs before prod — they are the only ones losing a configured behaviour.
4. Deploy to prod off-peak. `0054` and `0055` are data-only `UPDATE`s; there is no column drop and
   no ordering hazard with the worker (unlike `0051`).
5. Rollback is **not** "clear the policy" any more — that state no longer exists. A true rollback
   is a revert of the PR plus a migration restoring `NULL`. This is worth knowing before, not
   during, an incident.

---

## Pre-existing bug found while specifying this — fixed separately

**Manual cancellation did not release zoned seats.** `applyCancellation`
(`folios/handler.ts:378`) only decremented `slots.booked`, never `slot_zones.booked` and never
`reconcileSlotTotals` — while the three other release sites (`cancelBooking`, `rejectPayment`,
`sweepExpiredBookings`) all did both. Cancelling a zoned sale by hand left that zone's counter
inflated and its seats permanently unsellable.

Fixed **ahead of this feature**, on its own branch (`fix/cancellation-zone-release`), so the
inventory fix and this money-behaviour change land separately and can be rolled back
independently. Root cause, fix and coverage: **BUG-016** in `docs/BUGS.md`.

It was worth doing first for a plain reason: a policy engine makes cancelling routine, so a rare
bug becomes a frequent one. This spec assumes the fix is in — the seat-release behaviour it
describes is the post-BUG-016 behaviour.
