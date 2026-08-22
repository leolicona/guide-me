# Technical Debt Register

This document tracks known technical debt, deferred tasks, and architectural improvements that are planned for future phases.

## 30. Heading Levels Are Fixed at the Default, Not Yet Swept Per Screen — ⚠️ OPEN

**Context:** MUI maps `subtitle1`/`subtitle2` to `<h6>`, so for as long as the app has existed every
card title, row label and price rendered at subtitle size was silently a heading. The folio detail's
outline read `h1 → h6 → h3 → h6`, and a screen-reader user navigating by heading landed on
«$2,400.00» (`.design/folio-surface-parity/DESIGN_REVIEW.md`, Must Fix 2).

**What was fixed:** the DEFAULT — `theme.ts` now maps both variants to `<p>`, so nothing becomes a
heading by accident — plus the screens the design review actually covered: `SectionCard` titles
(`h2`), `FolioWorkActions` rungs (`h2`), the folio card's row title (`h2`), the folio detail's own
section headings, and the sheet hosts' titles (`h2` inside their dialog).

**What is left:** the other ~20 `subtitle1`/`subtitle2` call sites — the catalog wizard steps,
`AmenityPicker`, `UnitRow`, `BookingActions`, `RescheduleSheet`, `FolioStateSheet` and friends.
Nearly all of them are labels and row titles, which are **more** correct as `<p>` than as the `<h6>`
they used to be; but any that were genuinely a section's only heading now have none, and that has
not been verified screen by screen.

**Cost of leaving it:** a handful of regions may have no heading at all rather than a wrong one.
Neither state is navigable, so nothing got worse; it simply is not finished.

**What closing it looks like:** adopt `expectHeadingOutline()` (`test/axe.ts`, one line per screen)
in each screen's test and fix what it reports. The helper exists precisely so the sweep is cheap.

---

## 29. The Affiliate's Shift-Operator Filter Exists Server-Side and Is Unreachable — ⚠️ OPEN

**Context:** `listAgentFolios` accepts `?operator=<id>` and scopes the read to that shift operator
(`routes/pos/handler.ts:3830`), added with US-AF13 so a hotel manager could reconcile by turn. No
UI has ever sent it: `FolioHistoryPage` reads `operator_name` only to render the card's byline. The
manager's only tool for *"what did the night shift sell"* is reading names down the list.

**Why it is not fixed in the folio-surface-parity PRs:** it is a **fourth facet axis**, wanted by one
role, on a screen those PRs are already rewriting for three (`folio-surface-parity.spec.md` D14).
Adding a section to `FolioStateSheet` that renders for one surface only would be the first
audience-specific *filter*, which is exactly the kind of divergence that spec exists to remove — so
it needs its own story and its own decision about whether the admin gets a people axis too.

**Cost of leaving it:** a shipped server capability stays dead, and the affiliate manager keeps
scrolling. Nothing is incorrect; something is merely unreachable.

**What closing it looks like:** one `US-AF*` story, a facet section fed by the affiliate's operator
list, and the same `?operator=` the server already honours.

---

## 28. Two Units of One Property May Share a Name — ⚠️ OPEN

**Context:** `migrations/0035_create_accommodation_units.sql` declares `name text NOT NULL` with no
UNIQUE, and `routes/services/lodging.handler.ts:194` inserts without checking, so one property can
hold two active units called «Cabaña Río». Because the POS catalog is flattened — one card per unit
(US-AG37) — the duplicate reaches the seller as two visually identical cards with no way to tell
which inventory each draws from.

**Why it is not fixed in the US-A91 PR:** that PR closes both **reachable** frontend doors — the
wizard's attach mode feeds its guard from `useUnits(propertyId)` (D11) and the detail page's
`UnitFormSheet` shares `UnitFields` — so no UI path creates a duplicate any more. The server-side
constraint is a different unit of work: it needs a migration, a decision about duplicates that may
already exist in the live org (`prod` has a real tenant), and a `DUPLICATE_UNIT_NAME` error
contract. Bolting that onto a frontend-only PR would break its scope boundary.

**What is still wrong:** a direct API call, a seed script, or a future non-UI writer can still
create the collision, and nothing in the database prevents it.

**Fix when picked up:** a partial UNIQUE index over `(service_id, lower(name))` limited to
`status = 'active'` (deactivated units must be free to keep their names — folio history reads
them), a backfill that renames any existing collision deterministically, and `409
DUPLICATE_UNIT_NAME` declared in the spec's error table before it exists in code.
**Reference:** `docs/lodging/unit-authoring-entry.spec.md` § Deferred.

## 27. `updateService` Can Strand a Slot at Negative Effective Remaining — ⚠️ OPEN

**Context:** `routes/services/handler.ts:267–269` writes `flexCapacityPct: input.is_flexible ?
(input.flex_capacity_pct ?? 0) : 0` with **no validation against seats already sold**. A Soft Cap
service at `capacity 40 / flex 10 %` legally reaches `booked = 43`; turning Soft Cap off then
leaves that departure at an effective remaining of `(40 − 43) + 0 = −3`. The same hole exists for
*lowering* the percentage rather than clearing it.

**Why it is not fixed in the US-AG56 PR:** that PR fixes the **read** (BUG-031), and the read must
be correct however the write is later hardened. Deferring is safe *for the catalog* because the
read no longer sums: a negative slot can now only fail to advertise itself, where before it could
**suppress a sellable sibling** and make the card contradict the calendar.

**What is still wrong:** the stranded departure is scheduled but unsellable — it renders in the
service sheet, and every per-slot availability path correctly refuses it, with nothing anywhere
telling the admin they created it. The customers holding those 43 seats are unaffected; only new
sales into that departure are impossible.

**Fix when picked up:** refuse the update (`409`) when any future slot of the service would land
below zero under the new capacity mode, naming the departures — the same shape as the zone
operations, which already reconcile every future slot in one statement
(`routes/services/zones.reconcile.ts`). An admin who genuinely wants the reduction should cancel
or move the excess bookings first, which is a decision only they can make.

**Found:** 2026-08-21, while establishing the root cause of BUG-031.

---

## 26. `contextPills` Carries Copy the UI Never Renders (`PILL_LABELS`) — ✅ CLOSED (2026-08-21)

**Closed:** the copy became **live** rather than being deleted — which is the escape clause this
entry named. `defaultWindowLabel(today)` renders «Esta semana» / «Fin de semana» / «Hoy» on the
`/pos` calendar chip (`filter-strip-reset.spec.md` D14), so the strip states how much of the week it
is listing instead of hiding a 7× swing behind one word. `contextPills`, `PILL_LABELS`,
`ContextPillKey`, `ContextPill` and the never-read second pill are **deleted**; what survives is
`defaultWindow(today)` — the one range the function always served — plus the labeller.

The deferral reason resolved itself: this change *is* the PR where rewriting `dates.test.ts` is the
point. The old suite's concrete expected values for index `0` are ported verbatim to
`defaultWindow`, so the collapse carries its own equivalence proof (spec S-13) rather than leaning
on a boundary it had to edit.

<details>
<summary>Original entry (for history)</summary>


**Context:** `features/pos/dates.ts:90` defines `PILL_LABELS` (`ESTA SEMANA` / `ESTE FIN` /
`SIG. SEMANA`) and `contextPills` returns a `label` on every pill. Those labels were specified by
US-AG35 and **never rendered**: the only consumer, `PosCatalogPage`, reads `contextPills(today)[0]`
for its `from`/`to` and nothing else. `SPEC.md`'s US-AG35 line described the pills as shipped for
months — the drift that left the catalog's default window nameless until US-AG55
(`docs/pos/filter-strip-reset.spec.md` D12).

**Also unused:** the second pill of each branch (`este_fin` on Mon–Thu, `sig_semana` on Fri–Sun).
Only index `0` is ever read, and both branches compute the same `[0]` range (`today → comingSunday`).

**Why deferred:** `dates.test.ts` asserts the labels and both pills by name, and US-AG55's scope
boundary pins that file to pass **unedited** — so removing the copy means editing the very test that
proves US-AG55 changed no ranges. Doing it in the same PR would blur the two.

**Action required:**
- **Who:** whoever next touches `/pos` date context — or, if the context pills return as real
  controls, whoever builds them (at which point this stops being debt).
- **What:** collapse `contextPills` to the single default range it actually serves, drop
  `PILL_LABELS` and `ContextPillKey`, and rewrite `dates.test.ts` around the surviving contract.
- **Reference:** `docs/pos/filter-strip-reset.spec.md` (D12, Deferred table).

</details>


## 25. `folios.status` (+ its sibling roll-ups) Survive as Reconciled Columns — ✅ CLOSED (2026-08-12)

**Closed:** migration `0065` drops `folios.status`, `booking_expires_at`, `refund_status` and
`refund_amount`. No code in `src/` reads or writes them; every one of those four facts now derives
from `folio_lines` + `folio_payment_allocations` (`utils/folioStatus.ts`), and the three legacy
valves that used to fall back to the columns are deleted — a folio with no allocations reads as an
unpaid hold, which is the honest answer (`test/folios/derived-status.test.ts`). `cancelled_at`
carries what `status = 'cancelled'` used to: it is both the fact and the optimistic-flip guard.
The refund obligation travels to the lines through `applyCancellation`'s `reversal.refundAmount`
rather than through a folio column.

**Residual (fixtures only, no production surface):** `test/helpers/apply-migrations.ts` re-adds the
four columns as **test-only dead storage** after the migrations run, because ~27 test files express
a folio's intent by hand-seeding `INSERT INTO folios (…, status, …)` — including
`test/cash/agent-balance-cash-drops.test.ts`, which the line-autonomy spec's scope boundary requires
to pass unedited. `materializeSeededFolio` (`test/helpers/tenancy.ts`) reads that intent and
materializes it as line facts (a minimal line, the ledger row, the allocations, the stamps, the
clock) — the same shape 0062–0064 gave real pre-feature folios — and `readDerivedFolio` gives an
assertion the same answer the API serves. Sweep fixtures onto real line seeding opportunistically,
then delete the shim. Nothing in `src` can see those columns, so a fixture reading one gets what it
wrote, never the product's answer.

## 24. Two Date Vocabularies: `useOrgDateFormatter` Follows the BROWSER's Locale — ✅ CLOSED (2026-08-07)

**Closed:** the locale is pinned to `'es-MX'` inside the hook, matching `folioSoldAtLabel` (US-A82
D16) — one date vocabulary. Surfaced again by the folio-detail design review
(`.design/design-system/DESIGN_REVIEW-folio-detail.md`, Could Improve 1). The re-render check the
entry asked for (Spanish `month: 'short'` widths on Caja/Reportes/detail rows) is a visual pass on
dev after deploy; Spanish short months (`ago.`, `ene.`) are no wider than English ones.

**Status:** `useOrgDateFormatter` formats with `toLocaleString(undefined, { timeZone: tz, ...opts })`
(`useOrgDateFormatter.ts:16`). The **time zone** is the organization's, correctly — but the
**locale** is `undefined`, meaning whatever the browser is set to. On a device set to English, every
admin screen that uses it prints `Aug 2, 10:52 AM` inside otherwise-Spanish copy.

Meanwhile `folioSoldAtLabel` (US-A82 **D16**) pins `'es-MX'` deliberately, because a mixed-language
row was one of the four defects that shipped and were only caught by rendering. So the app now has
**two date vocabularies**, and which one a screen speaks depends on which helper it happened to use.

**Found:** rendering `FolioWorkActions` (US-A84) at 390px in a browser defaulting to `en-US`. It is
**not a regression** — the deleted `CancellationRequestsTab` formatted identically — and it was left
alone rather than pinned in one new component, which would have made the split three-way instead of
two.

**Action required:** pin the locale inside `useOrgDateFormatter` (one argument), then re-render the
admin screens that use it — Caja, Reportes, the folio detail, the affiliate surfaces — because
`month: 'short'` in Spanish is a different width and some of those rows are tight.

---

## 23. `GET /api/folios` Has No Limit, and Now Returns More Per Row — ⚠️ OPEN

**Status:** `listFolios` selects **every folio the organization has ever created** — no `LIMIT`, no
cursor, no `useInfiniteQuery` anywhere in the app. `folio-list-scanability.spec.md` (US-A82) widens
each row by roughly 150 bytes (`lines`, `portal_link`, `sale_mode`), so the same unbounded read now
costs more per folio. Dev holds ~101 folios; the shape of the problem is the org that holds 5,000.

The `undelivered` filter compounds it — it is applied **client-side** over the fully-loaded list
(`FoliosListPage.tsx:61-68`), so it structurally depends on everything being downloaded.

**Why it was not fixed now:** the scanability PR is a read-widening with no state change, and its
scope boundary is that reverting it changes not one row. Adding pagination changes the contract for
every consumer of the list and its five count badges. It also has to be **sequenced with search**:
the planned client-side search over the loaded list only finds what was downloaded, so pagination
and server-side search are one decision, not two.

**Worse than the entry above states.** The five count badges do not count — each fetches the whole
filtered list and calls `.length` in the browser (`useFolios.ts:35-77`), and `usePendingDeliveryCount`
downloads *every paid folio with its lines and portal link* to produce one integer. Measured per
load: `/folios` fires **4** unbounded `folios` reads, `/dashboard` fires **3**.

**Bounded, not closed, by `folio-lifecycle-unification.spec.md` (US-A84).** That feature caps the
read with a **union** — all folios with pending work regardless of age, plus the last 30 days of
everything else (D8/D9) — and replaces the five counting reads with one `GET /api/folios/counts`
doing real `COUNT(*)`. That removes the unbounded *growth*: the payload is now proportional to
30 days of sales plus the open work, not to the organization's entire history.

**What remains open after US-A84:** there is still no cursor and no `total_count`, so an
organization selling several hundred folios a day loads a large first page. Filtering also stays
client-side by design (US-A84 rule 8), which is safe only because the union makes the loaded set
complete for every pending-work facet — a future move to server-side faceting must not quietly drop
that guarantee.

**Action required:** whoever finds a real org where 30 days of sales is too large a payload. Add a
cursor + `total_count` to `GET /api/folios` and `GET /api/pos/folios`, convert
`useFolios`/`useMyFolios` to `useInfiniteQuery`, and move faceting server-side **together** — a
partial page under client-side facets produces filters that silently under-report, which is the
failure US-A84 D8 exists to prevent.

---

## 22. `Sin nombre` Survives on Three Folio Surfaces — ⚠️ OPEN

**Status:** `express-sale.spec.md` **D17** leaves `customer_name` NULL by design, and line 490 of
that same spec prescribed the fallback — `Cliente · ••1234` — which was never built. US-A82 builds
it as `folioCustomerLabel()` and adopts it in the shared `FolioCard`, covering `/folios` and
`/history`. Three surfaces still print the literal `Sin nombre`:

- `pages/FolioDetailPage.tsx`
- `features/folios/components/QueueRow.tsx` (Reembolsos + Vencidos tabs)
- `features/folios/components/CancellationRequestsTab.tsx`

So a counter-sold Express folio reads `Cliente ••5678` in the list and `Sin nombre` on its own
detail page — the same folio, two identities.

**Why it was not fixed now:** scoped deliberately to keep the scanability PR to the two list
surfaces it redesigns. The helper is shared from the day it lands, so each remaining surface is a
one-line change.

**Action required:** import `folioCustomerLabel` in the three files above and delete the
`?? 'Sin nombre'` fallbacks. No server change.

---

## 21. The API Contract Is Hand-Mirrored Into the Frontend — ⚠️ OPEN

**Status:** the response shapes the frontend expects live in `app-turistear/src/features/*/types.ts`,
typed by hand from the API's handlers. Nothing links the two. When an API response gains, renames or
drops a field, the mirror keeps compiling and the screen quietly renders `undefined` — `tsc` is
checking the frontend against the frontend.

`docs/TESTING.md` Phase 3 adds MSW handlers, which makes this **slightly worse before it gets
better**: a handler written from a stale type proves only that the frontend agrees with itself. The
convention that fixtures are copied from the shapes `api-turistear/test/**` asserts is a discipline,
not a mechanism — it holds exactly as long as everyone remembers it.

**Why it was not fixed now:** it needs a third workspace package (shared Zod schemas both sides
validate against) plus a pass over 16 service clients and every `types.ts`. That is a refactor of
its own, and doing it *inside* the phase that first introduces frontend tests would mean landing two
large changes with no gate to catch either.

**Action required:**
- **Who:** whoever next hits a bug where the API changed and the UI silently rendered nothing.
- **What:** a `packages/contracts` workspace exporting the Zod schemas for every API response; the
  API validates outbound with them, the frontend infers its types from them, and MSW fixtures are
  built by `schema.parse(...)` — so a drifted fixture becomes a test failure rather than a fiction.
- **Reference:** `docs/TESTING.md` § The known gap · `docs/testing/frontend-testing.plan.md` Phase 3.

## 20. Transactional Emails Are Off the Design System — ⚠️ OPEN

**Status:** every customer-facing email built in `api-turistear/src/services/resend.ts` uses its own
palette — `#1a1a2e` navy for ink and the CTA button, `#f5f5f7` panels, `#e0e0e0` rules — and
`font-family: sans-serif`. None of those values exists in `.design/design-system/DESIGN_TOKENS.md`.
The app is teal-accented Manrope on `#F8FAFC`; the email that lands in the customer's inbox is a
different product visually. Since the WhatsApp delivery feature the email is often the *only*
branded surface a tourist sees before the QR.

**Why it happened:** email clients cannot read CSS custom properties, so `tokens.css` is unusable
there and the templates were written with ad-hoc literals. The constraint is real; the conclusion
is not — the token *values* can be inlined, they just cannot be referenced.

**Action required:**
- **Who:** whoever next edits an email template.
- **What:** replace the literals with the token values (ink `#0F172A`, surface `#F8FAFC`, border
  `#E2E8F0`, CTA teal `#0F766E`, money semantic green/red) and load Manrope with a websafe fallback
  stack. Do it in one pass over all templates — a half-converted set is worse than a consistent
  wrong one.
- **Reference:** `.design/design-system/DESIGN_TOKENS.md`; the rule in `docs/PROCESS.md`
  (§ The design system has exactly one source).

## 19. Auth Specs Exist Twice — ⚠️ OPEN (documentation debt)

**Status:** `api-turistear/specs/auth/` holds five Spanish-language auth specs that predate the
`docs/` convention (`docs/PROCESS.md`). Four have English counterparts in `docs/auth/`; the folder
now carries a README saying it is not a spec location, and its dangling reference to a
`docs/auth/user-story-admin-registration.md` that never existed has been repointed at `docs/SPEC.md`.

**Why it was not simply deleted:** two of the five are not pure duplicates.
- `auth/agent-magic-link.spec.md` is the **only copy** — passwordless agent login by email *or*
  WhatsApp, 7 scenarios. It has no counterpart in `docs/auth/` and **no story in `SPEC.md`**, so it
  may describe a path that was designed and never built. Deleting it would drop the only record.
- `auth/agent-invitation.spec.md` is **16 lines longer** than `docs/auth/agent-invitation.spec.md`.
  The difference has not been read; it may be translation slack or it may be a scenario.

**Action required:**
- **Who:** whoever next touches auth.
- **What:** diff the two `agent-invitation` specs and fold anything real into `docs/auth/`; decide
  whether agent magic-link login is a live requirement (→ story in `SPEC.md` + spec in `docs/auth/`)
  or dead (→ delete). Then remove `api-turistear/specs/` entirely.

## 18. Accommodation Stays — Error Codes & `folio_lines` Rebuild — ✅ INTRODUCED & CONSUMED (no open debt)

**Status:** The accommodation/lodging feature (`docs/lodging/accommodation-stays.spec.md`) added three
error codes to the `ErrorCode` union in `src/types/errors.ts`, each thrown by a handler and asserted
by a test (`test/lodging/accommodation-stays.test.ts`) — introduced **and** consumed, no open debt:
- ~~`UNIT_UNAVAILABLE`~~ → **`INSUFFICIENT_INVENTORY`** (409) — v2 (Unit-Type Inventory, migration
  `0042`, `docs/RFCs/rfc-airbnb-inventory-model.md`): the per-unit overlap guard became a per-night
  COUNT guard (`reserved + blocked + requested ≤ inventory_count` ∀ night); the old code was removed
  from the union in the same change (no route emitted it any more) — no open debt.
- `SEASON_OVERLAP` (409) — a new season overlaps an existing active season for the type (admin API).
- `MIN_STAY_NOT_MET` (400) — a stay shorter than the type's `min_nights` (availability + sale).

**`folio_lines` rebuild (Option A):** migration `0040_alter_folio_lines_for_stays.sql` rebuilt
`folio_lines` to make `slot_id`/`slot_date`/`slot_start_time` nullable and add the stay columns
(`line_type`, `unit_id`, `check_in`, `check_out`, `guests`, `nights`) so a unified line list carries
both tour slots and lodging stays. SQLite can't drop NOT NULL/FK in place, so it is a table rebuild.

⚠️ **D1 remote per-statement FK enforcement (learned the hard way):** the first cut used the
Cloudflare-documented `PRAGMA defer_foreign_keys = TRUE` + drop/rename. It passed the test suite
(local Miniflare runs the migration file as one transaction, so the deferred check holds) but
**rolled back on `wrangler d1 migrations apply --remote`** with `FOREIGN KEY constraint failed`
(SQLITE_CONSTRAINT_FOREIGNKEY 7500). On remote, D1's `/query` endpoint enforces FKs **per
statement** and does **not** honor `defer_foreign_keys`, so `DROP TABLE folio_lines` orphaned the
`folio_line_extras` rows (the only inbound FK) the instant it ran. The rewrite keeps every statement
FK-valid: rebuild `folio_line_extras` *without* its `folio_lines` FK → swap `folio_lines` → rebuild
`folio_line_extras` again to restore all four FKs. Row ids are preserved across both copies, so each
check passes. **Takeaway for future table rebuilds: never rely on `defer_foreign_keys` for D1
`--remote`; order statements so no single statement violates a FK, or temporarily drop the inbound
FK.** Verified by the full suite via `applyD1Migrations` (the PRAGMA is kept as a harmless no-op
safety net for engines that do defer).

## 17. Cash Drawer — Retained Booking-Deposit Carve-Out — ✅ RESOLVED

**Resolved by the paid ledger (US-LG) + Cancellation Policy Engine Phase 3 (D20).** No carve-out was
ever needed; the premise below stopped being true in two steps.

1. **The paid ledger replaced status-exclusion with signed movement rows.** `cash/handler.ts` now
   sums `folio_payments` filtered by `entry_type` and `collected_by` — there is **no**
   `folios.status` predicate left. A cancelled folio contributes whatever its rows net to, so
   "cancelled folios are excluded from collected cash" no longer describes the system.
2. **The reversal became proportional.** That alone was not enough: the agent's apartado cancel
   still reversed the collected money *in full*, so a retained deposit netted to zero and vanished
   from the drawer anyway — the same under-count, arriving by a different route. Phase 3 routed that
   path through `cancelFolioPriced`, so the reversal now matches the refund and the retained
   portion stays on the books as money the company is owed.

An **expired** apartado (D21) writes no reversal rows at all, so its payment row stands untouched
and is likewise counted.

Regression coverage: `test/pos/pos-bookings-cancel.test.ts` — *"a retained deposit stays on the
books — the reversal is proportional, not total"*, which asserts the ledger nets to `+45,000` after
the cancellation. `docs/bookings/…` O3 and D7 are closed by the same change.

<details>
<summary>Original entry (kept for the record)</summary>

**Status:** Bookings/down-payments (`docs/bookings/bookings-down-payments.spec.md`, decision D7 /
open decision O3) ship with a **non-refundable retained deposit**: when a booking is cancelled
(manually via `POST /api/pos/folios/:id/cancel`, or by the auto-expiry sweep) the customer's
`amount_paid` **stays in the agent's cash drawer** and the folio goes to `status='cancelled'`,
`refund_status='none'`.

**The discrepancy:** the cash-drawer derivation (`api-turistear/src/routes/cash/handler.ts`) sums
`cash_collected` over **non-cancelled** folios only (`ne(folios.status, 'cancelled')`). So a
retained cash deposit on a cancelled booking is **excluded** from collected cash even though the
agent physically holds that money — the drawer would under-count by the deposit.

**Why deferred here:** the carve-out belongs to the *Cash drawer* feature's aggregation + its own
test surface (the bookings feature only sets `amount_paid`/`status`/`refund_status`). Wiring it in
the bookings PR would reach into another feature's derivation and tests.

**Action required:**
- **Who:** the cash-drawer owner (or the first PR that reconciles booking deposits into the drawer).
- **What:** in the `cash_collected` sum, include cancelled folios whose deposit was **retained**
  (a booking cancellation: `status='cancelled' AND refund_status='none' AND payment_method='cash'`),
  distinct from a refunding admin cancellation (US-A21, `refund_status` `pending`/`refunded`).
  Mirror the existing watermark-reversal logic (TECH_DEBT §12a) so a deposit retained pre-watermark
  isn't double-counted.
- **Reference:** `docs/bookings/bookings-down-payments.spec.md` §6 (cash-drawer row) + O3.

</details>

## 16. Tourist Portal — Deferred Notifications & Electronic Refund Movement — ⚠️ OPEN (by design)

**Status:** The Tourist Self-Service Portal (`docs/tourist-portal/tourist-self-service-portal.spec.md`)
shipped with two deliberate deferrals:

1. **No admin email on a new cancellation request (spec D7).** The request surfaces via the
   in-app queue + nav badge only (the same precedent as Advanced Cash Collection's D1 — no
   admin-facing event-email infra exists). Layerable on Resend later with no model change.
2. **No electronic money movement on refunds.** There is no payment gateway (Phase-1 pivot),
   so `POST /api/folios/:id/refund/confirm` *records* that a refund happened — for cash it is
   the physical hand-back (proven by the portal PIN), for card/transfer/link the admin
   processes the return out-of-band and records it here (typically via the override-note path).

**Action if revisited:** (1) add a `sendCancellationRequestEmail` to `services/resend.ts` and
fire it from `submitCancellationRequest` via `waitUntil`; (2) when a gateway lands, hang the
actual refund call off the same `pending → refunded` transition.

## 15. External QR-Image Service Dependency — ⚠️ OPEN (accepted trade-off)

**Status:** The Client Ticket Delivery feature (`docs/email/client-ticket-delivery.spec.md`) embeds QR codes in the HTML email using external image tags pointing to `api.qrserver.com/?data=<token>`.

**Why accepted:** Generating raw PNG bytes entirely within a Cloudflare Worker requires either a WebAssembly module (like `qr-wasm`) or a pure JS implementation that does not rely on Node's Canvas/Buffer. Using the external URL is an acceptable MVP shortcut to deliver the email without expanding the build complexity.

**Action if revisited:** If `api.qrserver.com` rate-limits or the privacy of embedding the token in a URL parameter becomes a concern, self-host a `/api/qr/:token.png` endpoint within the Worker (using WASM) and change the Resend template to point to our own domain.

## 14. Daily Cash-Drawer Feature Superseded & Removed — ✅ RESOLVED (replaced)

**Status:** The daily cash-closure (*corte de caja*) feature — `cash_drawers` /
`cash_drawer_expenses` tables, the `/api/cash-drawers` router, its tests, the agent **Caja**
page and admin **Closures** list/detail UI — was **removed end-to-end** and **replaced** by
the perpetual *Agent continuous cash balance with cash drops* feature
(`docs/cash-drops/agent-balance-cash-drops.spec.md`). Migration `0018_drop_cash_drawers.sql`
drops both tables (expenses → drawers, FK order); the Drizzle defs, routes, services, hooks,
pages, nav entries and route constants are all gone (verified: no dangling references in
`api-turistear/src` or `app-turistear/src`).

**Why accepted:** the operationally meaningful number is "how much company cash is this agent
holding **right now**", not a paper reconciliation pinned to a calendar day. The continuous
running balance (server-derived from events, never stored) replaces the day snapshot, and the
cash-drop `pending → confirmed | rejected` machine reuses the closure review pattern — so the
old model carried no behaviour worth keeping. The drop assumed **no production cash-drawer
data to preserve** (the daily-closure feature shipped immediately before this pivot).

**Action if revisited:** none — this is a completed replacement, not open debt. The drop
migration is **destructive**; if a remote D1 ever held real `cash_drawers` rows, that data is
not recoverable from these migrations (snapshot before applying `0018` remotely).

## 13. Commission Per-Service Bonus Not Manageable (US-A12) — ✅ RESOLVED

**Status:** **Closed** by the *Commissions* feature
(`docs/commissions/commissions.spec.md`). `services.commission_bonus` now has a full write
path: it is in `createServiceSchema`/`updateServiceSchema` (integer minor units, ≥ 0, default
0), persisted by `createService`/`updateService`, returned by `serializeService` on list +
detail, and editable via a *Commission bonus* field in the catalog service form
(`ServiceFormDialog`). The read-side was already in place — `confirmSale` snapshots
`commission_amount = round(total × users.base_commission / 100) +
Σ(line.quantity × services.commission_bonus)` and the balance derivation deducts it — so both
halves of US-A12 (base % per agent + bonus per service) now flow end-to-end. Covered by
`test/catalog/service-catalog.test.ts` (create/default/validation/edit/read + snapshot
immutability) and `test/pos/pos-controlled-discount.test.ts` (the calc). No schema change was
needed (the column shipped with migration `0023`).

## 12. Agent Cash-Balance — Deferred Refinements — 🟡 MOSTLY RESOLVED

**Status:** Paid down by the *Agent Cash-Balance Refinements* work
(`docs/cash-drops/balance-refinements.design.md`). The high-leverage primitive is a
**settlement watermark** — `cash_drops.balance_after`, stamped at confirm time (migration
`0024_add_settlement_to_cash_drops.sql`). (a), (b), (d), and the anchor/cancellation parts of
(e) are **resolved**; (c)'s amount-adjustment mechanics are **shipped** but its
acknowledgment/signing flow is **still pending** (tied to US-AG27, below); one sub-case of (e)
is **out of scope** (unreachable). Covered by `test/cash/agent-balance-cash-drops.test.ts`
(Scenarios 4a, 5a, 10b, 12a, 12b, 14a–14c), with Scenario 12a a **regression gate** proving the
watermark-anchored headline equals the independent all-time recompute.

- **(a) Settled history is now frozen.** ✅ The watermark is the boundary. An expense
  `created_at <= watermark` refuses deletion (`409 CONFLICT`, `deleteExpense`); a pre-watermark
  folio cancelled *after* the watermark is no longer silent — `deriveBalance` adds a **reversal
  term** (`sumCancellationReversal`) that surfaces the reversed cash (and any clawed-back
  commission) in the **current shift**, leaving the settled `balance_after` frozen. *(This
  changed Scenario 4's split for the watermarked path — the reversal now lands in the live shift,
  not `carry_forward`; the legacy/no-watermark path is unchanged and still covered by Scenario 4.)*
- **(b) Per-read work is now bounded.** ✅ `deriveBalance` has a fast path:
  `balance = balance_after + Σ(events since the watermark)` — O(shift), not O(history). The shift
  breakdown and the authoritative balance are one computation, and `carry_forward` is read
  **directly** from `balance_after`. Confirming is also bounded (new `balance_after` = prior
  watermark + since-sums − amount). A legacy confirmed drop with no `balance_after` transparently
  falls back to the full-history derivation.
- **(c) Adjust-amount-on-confirm — mechanics shipped, acknowledgment pending.** 🟡 `reviewDrop`
  accepts an optional `amount`; confirming with a corrected value updates the balance immediately,
  stashes the agent's original into `amount_requested` (new column), and audits the delta in
  `review_note` (admin UI: `CashDropDetailPage` confirm dialog + a requested-vs-confirmed line).
  **Still to build:** the "Silent Acknowledgment" / non-blocking notification flow shared with
  **Admin-Initiated Direct Collection (US-AG27)** — the agent is notified to digitally
  sign/acknowledge the adjustment, auto-signing after 24h if ignored. Until US-AG27 lands, an
  adjustment is applied + audited but not agent-acknowledged.
- **(d) `listBalances` N+1 removed → later superseded by the US-A19 shift-scope upgrade.** ✅
  Originally replaced the per-agent loop with `GROUP BY agent_id` aggregates merged in memory
  (O(1) queries, all-time totals). **Superseded:** US-A19 was upgraded to require a per-agent
  **shift-scoped** breakdown (collected/commissions/expenses since each agent's last confirmed
  drop, plus a carry-forward line) for clean daily reconciliation — which a single grouped query
  can't express without a per-agent watermark join. Since the watermark made each `deriveBalance`
  O(shift), the loop is no longer pathological: `listBalances` now maps every agent through the
  **canonical `deriveBalance`**, fired concurrently (`Promise.all`), so the admin row mirrors the
  agent's `/me` view exactly (single source of truth). The headline `balance` stays all-time.
  Design + regression gate: `docs/cash-drops/admin-shift-scoped-balances.design.md`. O(1) escape
  hatch (conditional aggregation over a per-agent watermark window) recorded there for if an org
  ever reaches hundreds of agents.
- **(e) Shift attribution.** ✅ (mostly) The anchor now follows the **settlement timeline**
  (`reviewed_at`, tiebreak `created_at`), so out-of-order confirmation resolves to the drop
  confirmed last; post-drop cancellations surface via the (a) reversal. ⚠️ **Out of scope (still
  deferred):** a **booking whose `amount_paid` grows across a confirmed drop** — *currently
  unreachable*, because `amount_paid` is written once at folio creation and never grown (no
  endpoint mutates it). Revisit only if such an endpoint is introduced; the §4.2 reversal pattern
  then generalises to a signed adjustment ledger keyed on payment events.

**Known limitation (accepted, consistent with §6):** timestamps are whole-second, so the fast-
path boundary `created_at > reviewed_at` is fuzzy for an event landing in the *same wall-clock
second* as a confirmation. Admins confirm drops seconds/minutes apart, so this is a sub-second
concurrency edge; the fallback / `/balances` recompute stays exact.

## 11. Client Cancellation Email Not Sent (US-C03) — ✅ RESOLVED

**Status:** Closed by the Client Ticket Delivery feature (`docs/email/client-ticket-delivery.spec.md`). `cancelFolio` (`src/routes/folios/handler.ts`) now sends a Resend notification after the batch commits when `folio.customer_email` is set.

**Why accepted:** This resolves the previous technical debt. The cancellation email effectively notifies users and prevents confusion.

**Forward seam — Refund PIN (US-A23 / US-T05):** when the Tourist Self-Service Portal
(Phase 2) and Cash Refund Tracking land, the physical-cash-returned loop closes here too.
The flow will be: admin approves cancellation → `cancelFolio` generates a secure one-time
`refund_pin` stored on the folio → tourist portal (US-T05) shows it → agent/admin enters the
PIN to confirm the cash was handed back (`refund_confirmed_at`). The `folios` table already
carries the full cancellation audit; the only additions will be two nullable columns
(`refund_pin`, `refund_confirmed_at`) added when that feature lands.

> **Note — partial cancellation stays out of scope.** Per-service / per-line cancellation is
> explicitly **WON'T HAVE THIS TIME** in the SPEC; this feature is total-only by design and
> that is not debt to be paid down in the MVP.

## 10. Strictly-Online QR Scanner (offline sync is Phase 2) — ⚠️ OPEN (by design)

**Status:** Intentional MVP scope, set by the Online QR Scanner feature
(`docs/scanner/online-qr-scanner.spec.md`) and the SPEC design principle. `POST
/api/tickets/scan` validates and redeems **only** against the server (the single source of
truth for `redeemed_count`); the frontend refuses to scan when offline (US-AG19) rather
than queueing.

**Why accepted:** the MVP gate scenario assumes connectivity (3G/4G/WiFi); real-time
redemption avoids any reconcile/conflict logic. The signed-token structure
(`src/utils/qr.ts`) was deliberately built to support offline verification later **without
reissuing tickets** — the signature can be checked locally against the per-org key.

**Action if revisited:** Phase 2 (US-AG16) adds offline validation — verify the signature
locally (bad signature → fake), store consumed `folio_line_id`s in `localStorage`, and
reconcile via `POST /api/tickets/sync`; the server stays authoritative on `redeemed_count`
(it must clamp at `quantity` when applying a synced batch, surfacing over-redemptions that
happened across offline devices).

## 9. Ticket Scan Is Not Idempotent — ⚠️ OPEN (accepted trade-off)

**Status:** Accepted limitation of `POST /api/tickets/scan` (Online QR Scanner). Each
successful call redeems exactly one pass; there is no idempotency key. If the response is
lost in flight and the agent rescans the same code, a second pass is redeemed.

**Why accepted:** the frontend mitigates the common case by **re-arming** between scans
(`ScannerPage` pauses the camera after each scan and waits for "Scan next"), so the same
physical QR fires one request per deliberate scan; a genuine network-loss + rescan is rare
and visible (the agent sees the progress jump). The atomic `redeemed_count < quantity`
guard still prevents redeeming **past** the purchased total.

**Action if revisited:** if field data shows duplicate redemptions, accept a
client-generated `scan_id` (idempotency key) on the scan body and dedupe server-side
(requires the redemption audit table from §8 to record applied keys). No ticket-format
change is required.

## 8. Redemption Audit Log Deferred — ⚠️ OPEN (YAGNI)

**Status:** Deferred by the Online QR Scanner feature. Redemption state is a single
counter, `folio_lines.redeemed_count` (migration `0014`), which is all US-AG17 needs
("Pass N of M used"). There is **no** per-scan audit table (who scanned, when, which pass,
on what device).

**Why deferred:** no MVP feature reads per-scan rows — the count alone drives the result
screen — so adding a `ticket_redemptions` table now would be unused schema (same YAGNI
discipline as §1). The single atomic `UPDATE … redeemed_count + 1` is sufficient for
correctness.

**Action if revisited:** the first feature that **reports** on redemptions (cash drawer /
admin dashboard / commissions, or the §9 idempotency key, or the §10 offline-sync
reconcile) introduces `ticket_redemptions` (`id`, `organization_id`, `folio_line_id`,
`scanned_by`, `scanned_at`, `pass_number`) and writes one row per successful scan inside
the same path that increments `redeemed_count`.

## 7. Per-Org QR Signing by Key Derivation (no rotation) — ⚠️ OPEN (accepted trade-off)

**Status:** Accepted design, introduced by the signed-QR feature
(`docs/qr/folio-qr-signing.spec.md`). The SPEC requires each ticket "signed with
HMAC-SHA256 using a `QR_SECRET` per organization." Rather than store a per-org secret
column (generation-on-create + a backfill for existing orgs), `src/utils/qr.ts` keeps a
**single** Worker secret `QR_SECRET` and derives the per-org signing key as
`orgKey = HMAC-SHA256(QR_SECRET, "guideme:qr:v1:" + organizationId)`. This satisfies "per
organization" (distinct key per org; a ticket minted for one org cannot verify under
another's derived key — multitenancy in the signature itself) with **no schema change and
no backfill**.

**Why accepted:** `QR_SECRET` is a Worker secret (`wrangler secret put QR_SECRET`); only
the derived key signs, and neither leaves the server. Covered by
`test/qr/qr.unit.test.ts` (cross-key isolation) and `test/qr/folio-qr-signing.test.ts`
(Scenarios 4, 11).

**Action if revisited:** **secret rotation is not yet supported** — there is no `kid` and
rotating `QR_SECRET` would invalidate every already-issued ticket. The payload `v: 1` and
the `"guideme:qr:v1:"` key label reserve room for a versioned scheme (embed a key id,
verify against the matching secret) without reissuing tickets. Add it when rotation is
needed.

## 6. QR `expires_at` Single-Timezone Assumption — ⚠️ OPEN (accepted trade-off)

**Status:** Accepted MVP simplification in `src/routes/pos/handler.ts` (`ticketExpiry`),
introduced by the signed-QR feature. A ticket's `expires_at` is
`unixtime(slot_date @ 00:00 UTC) + 48h` — valid through the end of the day after the tour.
This mirrors the existing naive-calendar assumption already used by Schedules/Slots and
POS (dates are timezone-less `YYYY-MM-DD` strings).

**Why accepted:** the platform is single-timezone in the MVP; the 48h grace comfortably
covers late-evening slots and next-morning stragglers regardless of the org's real offset.
This feature only **stamps** `expires_at`; the *Online QR Scanner* feature enforces it.

**Action if revisited:** when organizations gain a real timezone (a broader change touching
schedules/slots/POS too), compute `expires_at` from the slot's local datetime rather than
UTC midnight. No ticket-format change is required — `expires_at` is already an absolute unix
timestamp.

## 5. `verifyTicket` Shipped Ahead of Its Production Consumer — ✅ INTRODUCED (no open debt)

**Status:** `src/utils/qr.ts` exports `verifyTicket` alongside `signTicket`/`deriveOrgKey`,
introduced by the signed-QR feature (`docs/qr/folio-qr-signing.spec.md`). Only `signTicket`
runs in a production request path today (folio confirm). `verifyTicket` is the *Online QR
Scanner* feature's future production consumer; here it is exercised by this feature's own
tests (roundtrip, tamper, cross-key, and the read-path integrity check in
`readFolio`/`getFolio`).

**Why no debt:** unlike a deferred-and-unused code path, a signer is only meaningfully
testable against its verifier, and `verifyTicket` **is** consumed now — by `getFolio`
(integrity-checks the stored token before echoing its payload) and by the QR test suites.
No dead code; the scanner simply becomes its second caller.

## 4. D1 Has No Interactive Transactions — ⚠️ OPEN (accepted trade-off)

**Status:** Accepted limitation, surfaced by the POS sale-confirm
(`docs/pos/pos-controlled-discount.spec.md`). The Cloudflare D1 Workers binding offers
`batch()` (all-or-nothing **on error**) but **not** interactive transactions, and a
conditional `UPDATE` that matches **0 rows is not an error** — so a batch cannot
conditionally abort when a slot is sold out. `confirmSale`
(`src/routes/pos/handler.ts`) therefore uses a **validate → conditional-decrement →
compensate** flow: it decrements each slot with
`UPDATE slots SET booked = booked + n WHERE … AND capacity - booked >= n RETURNING id`,
and if any decrement matches 0 rows it re-increments (`booked - n`) the slots already
decremented in that confirm, then throws `409 SLOT_UNAVAILABLE`. The folio rows are
written only after all decrements succeed, in a single `db.batch`.

**Why accepted:** the compensation window is sub-millisecond and bounded by cart size;
the `capacity - booked >= n` guard plus the `slots_active_unique_idx` partial index are
the DB-level backstops. Covered by `test/pos/pos-controlled-discount.test.ts` Scenario 10
(roomy slot is rolled back, sold-out slot untouched, **no** folio written).

**Action if revisited:** if D1 gains interactive transactions (or the sale moves to a
Durable Object for serialized inventory), replace the compensation with a real
transaction. No schema change is required.

## 3. POS Error Codes (`PRICE_BELOW_MINIMUM`, `SLOT_UNAVAILABLE`) — ✅ INTRODUCED & CONSUMED (no open debt)

**Status:** Introduced and consumed together by the Mobile Point of Sale feature
(`docs/pos/pos-controlled-discount.spec.md`). Both were added to the `ErrorCode` union in
`src/types/errors.ts` and are consumed by the POS confirm endpoint
(`POST /api/pos/folios`): `400 PRICE_BELOW_MINIMUM` when a line's `unit_price` is below the
snapshot `minimum_price` (US-AG06 controlled-discount floor), and `409 SLOT_UNAVAILABLE`
when a slot can no longer satisfy the requested quantity at confirm time (US-AG11 race
protection). Like the `CONFLICT` case (§2), the codes were added at the same time as their
first use, so no debt is opened. Covered in `test/pos/pos-controlled-discount.test.ts`
(Scenarios 7 and 10).

## 2. `CONFLICT` Error Code — ✅ INTRODUCED & CONSUMED (no open debt)

**Status:** Introduced and consumed together by the Schedules & Slots feature
(`docs/schedules/schedules-slots.spec.md`). `'CONFLICT'` was added to the `ErrorCode`
union in `src/types/errors.ts` and is consumed by the slot/schedule endpoints, which
return `409 CONFLICT` for: a duplicate active slot at `(service, date, start_time)`, an
edit/reactivate that would collide with another active slot, and an edit that would set
`capacity` below the already-booked spots. Unlike the deferred `NOT_FOUND` case (§1),
this code was added at the same time as its first use, so no debt is opened. A partial
unique index (`slots_active_unique_idx … WHERE status = 'active'`) backs the handler
pre-checks at the DB layer. Covered in `test/catalog/schedules-slots.test.ts`
(Scenarios 4, 7, 9).

## 1. Deferred `NOT_FOUND` Error Code — ✅ RESOLVED

**Status:** Resolved by the Service Catalog feature (`docs/catalog/service-catalog.spec.md`).
`'NOT_FOUND'` is present in the `ErrorCode` union in `src/types/errors.ts` and is now
consumed by `GET /api/services/:id` (and the other org-filtered service/extra
endpoints), which return `404 NOT_FOUND` for unknown or cross-org ids without
revealing whether the resource exists in another organization (Scenarios 6, 11, 14,
17). Cross-org isolation is covered in `test/catalog/service-catalog.test.ts`.

<details>
<summary>Original entry (for history)</summary>

**Context:** 
The Multitenancy specification (Scenario B3) dictates that when a user attempts to fetch a resource by ID that belongs to a different organization, the system must return a `404 Not Found` error. This prevents information leakage across organizations by not confirming whether the resource actually exists or not.

**Current State:**
The global `ErrorCode` union in `src/types/errors.ts` does not currently define a `NOT_FOUND` error code.

**Why Deferred?**
The foundational Multitenancy implementation plan (Phase 2) only introduced the `GET /api/organizations/me` endpoint. If the user's organization is missing, it is considered an invariant violation (internal error), so it returns `500 INTERNAL_ERROR` instead of `404`. Since no endpoint in this phase requires the `NOT_FOUND` code, adding it now would introduce unused code (violating YAGNI).

**Action Required:**
- **Who:** The developer implementing the first resource-detail endpoint (e.g., Service Catalog, where `GET /api/services/:id` is needed).
- **What:** Add `'NOT_FOUND'` to the `ErrorCode` union in `src/types/errors.ts`.
- **Reference:** `docs/multitenancy/implementation-plan.md` (Phase 4, Task 4.3)

</details>
