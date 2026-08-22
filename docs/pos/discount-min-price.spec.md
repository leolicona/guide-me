# Feature: An agent can discount a stay, down to a ceiling the admin sets per unit

> Process: `docs/PROCESS.md`.
>
> **Status: BUILT.** Supersedes `docs/lodging/accommodation-stays.spec.md` § *Out of scope*
> ("Per-night manual discount on a stay … discounting stays is deferred") and its § 5 commission
> exemption ("Lodging stays exempt from the fixed ≤ `minimum_price` cap — no per-ticket floor"),
> whose stated reason this feature removes. Tours are **not** in scope: their controlled discount
> (`docs/pos/pos-controlled-discount.spec.md`, US-AG06) ships and is untouched.

## Context

An agent selling a tour can close a deal by shaving the price: the checkout line carries an
editable *Precio unitario* bounded by `minimum_price` and `base_price`, validated again on the
server (`pos/handler.ts` — `400 PRICE_BELOW_MINIMUM` below the floor, `400 VALIDATION_ERROR` above
the ceiling).

An agent selling a stay cannot. `stayLineSchema` accepts no price at all — `unit_type_id`,
`check_in`, `check_out`, `guests`, `quantity` and nothing else — and the confirm handler writes the
re-quoted number three times over:

```ts
basePrice: quote.total,   // no per-night discounting → base == sold (whole line)
minimumPrice: 0,
unitPrice: quote.total,
lineTotal: quote.total,
```

`StayCartLine` renders that total as a `MoneyText`, not a field. So «¿me lo dejas en 1,800?» at the
counter has exactly one answer, and it is *no* — not because the operator decided the margin is
thin, but because nobody built the input. The same operator's tours discount freely.

The floor cannot be an amount per night. A stay's total is assembled night by night
(`utils/lodging.ts` → `quoteStay`): `seasonal > weekend > base` per night, times rooms, plus the
extra-person surcharge over an even guest split. Two rooms, three nights, one of them a Saturday,
one guest above base occupancy — the total is not `rate × nights × rooms` and never was. A
`minimum_nightly_rate` column would need a second engine to resolve seasons and weekends the same
way the first one does, and the day the two disagree the sale is refused for a reason nobody can
reconstruct. The floor here is a **percentage of whatever the one engine quoted**.

## Scope boundary

- **`api-turistear/test/lodging/` and `api-turistear/test/pos/pos-controlled-discount.test.ts`
  pass unedited.** The tour path — schema, floor, ceiling, error code, HTTP status — is not
  touched. `PRICE_BELOW_MINIMUM` stays **400**; it is asserted at
  `pos-controlled-discount.test.ts:429`, `express-sale.test.ts:186` and
  `affiliate-portal.test.ts:215`, and documented as 400 in four specs.
- **With `max_discount_pct = 0` — the migration default, therefore every row that exists today —
  the product is byte-identical.** The confirm accepts only `quote.total`; `StayCartLine` renders
  the total as text with no control; `discount_total` stays 0. An org notices this feature only
  after an admin types a number into a unit.
- No new error code. No change to how a stay is quoted, to `quoteStay`, or to the per-night
  atomic inventory guard.
- Express sales are unaffected: `sale_mode: 'express'` is one **slot** line by construction.

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | Lodging only. The tour discount is not touched — not its clamp, not its error code, not its status. | The tour path works end to end and nobody has reported a defect in it. Bundling a change to it would put a working feature at risk inside a migration that has nothing to do with it, and would break three test files for no reported need. |
| **D2** | `accommodation_unit_types.max_discount_pct integer NOT NULL DEFAULT 0` — a whole percent of the quoted total. | Relative, so it survives seasons, weekend rates, room count and the extra-person surcharge without re-deriving any of them. `DEFAULT 0` is the deterministic backfill prod requires: no `UPDATE`, and every existing unit keeps exactly today's behaviour. |
| **D3** | Floor = `Math.ceil(quote.total × (1 − pct/100))`. | The floor protects margin, so a sub-centavo remainder rounds **toward the operator**. `ceil` also makes the boundary case predictable from memory instead of depending on which centavo the quote landed on. |
| **D4** | The agent edits the stay's **total in pesos**; the server converts once to check it. | The negotiation at the counter is «te la dejo en $1,850», never «12 %». And `unit_price` already *is* the whole-line total for a stay by schema invariant (`folio_lines`: `base_price = unit_price = line_total`), so `stayLineSchema` gains one optional field rather than a new concept. |
| **D5** | Nothing invalidates an override, because a stay line cannot be edited in place. | `addStayLine` appends; `updateQuantity` guards `l.kind === 'slot'`; there is no `updateStay`. Changing dates, guests or rooms means removing the line and re-adding it from `LodgingStaySheet` — a new `id`, a fresh quote, no stale override to carry. The decision costs zero code and cannot rot. |
| **D6** | The availability payload carries `min_total` (pesos), not `max_discount_pct`. | One definition of the floor, on the side that owns the quote. The client compares two numbers it was handed and never implements `ceil` — so the field the agent sees and the bound the server enforces cannot drift by a centavo. |
| **D7** | With `min_total === total` the line renders as text, with no control. | A field that can only ever reject the agent's input is noise on a counter. It also makes the scope boundary mechanical: feature off ⇒ `StayCartLine` is the component it is today. |
| **D8** | The confirm writes the resolved floor into `folio_lines.minimum_price`, replacing the hardcoded `0`. | The column exists, is `NOT NULL`, and is already snapshotted for tours. The unit's percent can be edited after the sale; without the snapshot nobody could reconstruct what the line was actually validated against — the reason tours snapshot theirs. |
| **D9** | A stay line's discount counts **once**: `base_price − unit_price`, not `× quantity`. | `discountTotal` reduces `(l.basePrice − l.unitPrice) * l.quantity` over every line. For a slot line those are per-spot and `quantity` is spots, so the multiplication is right. For a stay line they are whole-line totals and `quantity` is **rooms** — a $150 discount on a two-room stay would be persisted and shown to the org as $300. |
| **D10** | A **fixed** commission on a stay line is clamped to that line's `line_total`, at confirm. | `accommodation-stays.spec.md` § 5 exempts lodging from the `fixed ≤ minimum_price` cap *because lodging had no floor*; this feature removes that reason. Authoring-time validation cannot replace it — the floor is a percentage of a total that does not exist until the dates, rooms and guests are known — so the clamp goes where the number is finally known. A **slot** line is deliberately left alone: its authoring guard already pins `fixed ≤ minimum_price ≤ unit_price`, so the clamp would be a mathematical no-op that quietly claimed the tour path was in scope. |
| **D11** *(added during the build)* | `max_discount_pct` is `.optional()` in the frontend form schema, not `.default(0)`. | `.default()` splits zod's input and output types, and RHF's `Resolver<TFieldValues>` then stops typechecking in both unit-form hosts. Absent still means "no discount" — the same thing migration `0066` says about every pre-existing row — resolved at the two places that serialise (`UnitFormSheet.toInput`, `useCreateLodgingFull`). It also leaves `schemas.test.ts` passing unedited. |
| **D12** *(added after use — supersedes this spec's own Frontend note)* | The money figure and the discount field are **one element**: `components/EditableMoney.tsx`. It renders `formatCents` in tabular Manrope 700 at rest, drops to the raw major-unit number on focus, and clamps into `[min, max]` on blur. All three POS price surfaces use it — the cart's tour line, the cart's stay line, and `ExpressSalePanel`. | Shipping the stay field as a `TextField` *beside* a `MoneyText` left the most expensive figure in the cart with no money read at all, and made three renderers of one concept where there had already been two. A single primitive also makes D7 fall out for free: with `min >= max` it renders the `MoneyText`, so the border — and nothing else — is what says *this can be negotiated*. |
| **D13** *(added after use)* | «Cobrar» is **not** gated on line validity, in any surface. | `EditableMoney` clamps before it calls its owner, so an out-of-band price cannot reach the store. A gate would defend against a state no code path can produce. |

## Data Model

### Migration `0066_unit_max_discount.sql`

```sql
-- US-A92 (docs/pos/discount-min-price.spec.md, D2). A unit type's discount ceiling, as a whole
-- percent of the SERVER-QUOTED stay total. Relative rather than absolute: the total is assembled
-- per night from seasonal > weekend > base, times rooms, plus the extra-person surcharge over an
-- even guest split (utils/lodging.ts quoteStay). An absolute per-night floor would need a second
-- engine to resolve the same precedence, and would drift from the first one silently.
--
-- DEFAULT 0 IS the backfill (D2): every existing row — prod's live org included — keeps today's
-- behaviour, which is "the quoted total or nothing". No UPDATE, nothing to make idempotent.
ALTER TABLE accommodation_unit_types ADD COLUMN max_discount_pct INTEGER NOT NULL DEFAULT 0;
```

Drizzle (`src/db/schema.ts`, `accommodationUnitTypes`):

```ts
// US-A92 — discount ceiling as a whole percent of the quoted stay total (0 = no discount).
// Authoritative for the FLOOR; the floor itself is derived per quote, never stored on the type.
maxDiscountPct: integer('max_discount_pct').notNull().default(0),
```

Nothing is cached. The floor is `ceil(quote.total × (1 − pct/100))`, recomputed wherever the quote
is — and snapshotted onto the line at confirm (D8) so the sold line stays readable after the
percent is edited.

## Business rules (enforced server-side)

1. A stay line's `unit_price`, when supplied, must be **≥ `ceil(quote.total × (1 − max_discount_pct / 100))`**. Below → `400 PRICE_BELOW_MINIMUM`.
2. A stay line's `unit_price`, when supplied, must be **≤ `quote.total`**. Above → `400 VALIDATION_ERROR`, mirroring the tour ceiling.
3. When `unit_price` is **omitted**, the line prices at `quote.total` exactly as today — the whole payload path is unchanged for a client that does not send it.
4. `max_discount_pct = 0` therefore admits only `unit_price === quote.total`; rules 1 and 2 collapse onto the same number.
5. `folio_lines.minimum_price` for a stay line is the **resolved floor**, not `0` (D8).
6. `folio_lines.base_price` stays `quote.total` (what the stay is worth); `unit_price` and `line_total` become the discounted total.
7. `folios.discount_total` adds **`base_price − unit_price`** for a stay line, un-multiplied by `quantity` (D9). Slot lines keep `× quantity`.
8. A **fixed** commission on a stay line contributes `min(commission_value × quantity, line_total)` (D10). A **percent** commission needs no clamp — it is basis points of the discounted `line_total` and cannot exceed it.
9. `max_discount_pct` is an integer in `[0, 100]`, rejected outside that range at the unit-type schema. *(Frontend mirrors this; the server is authoritative.)*

## Authorization — who may do this

Anyone who may confirm a POS sale: **agent, admin, and affiliate**. Affiliates already discount
tours to the floor through this same endpoint
(`affiliate-portal.spec.md` — AF06, "exactly like an agent"), so a stay behaves the same way; the
allow-list gate on the parent service is unchanged and still runs first.

Setting `max_discount_pct` is **admin-only**, on the existing unit-type create/update routes.

A cross-org attempt returns `404` — the unit-type lookup in the confirm path is already scoped by
`organization_id`, so a foreign `unit_type_id` is not found rather than refused.

## API surface

### `POST /api/pos/folios` — stay line gains an optional price

```ts
// stayLineSchema (routes/pos/schema.ts)
unit_price: money.optional(),   // whole-line total for the stay; omitted ⇒ the server's quote
```

Server-derived and refused from the body, unchanged: `organization_id`, `agent_id`, `status`,
`line_total`, `base_price`, `minimum_price`, `commission_*`, every folio total.

### `POST` / `PUT /api/services/:serviceId/unit-types/:id` — admin sets the ceiling

```ts
max_discount_pct: z.number().int().min(0).max(100).optional(),   // defaults to 0
```

Surfaced back on the unit-type response row alongside `commission_type` / `base_rate`.

### `GET /api/pos/lodging/:serviceId/availability` — the floor travels with the quote

Each `unit_types[]` entry gains one field beside `total`:

```ts
min_total: number,   // ceil(total × (1 − max_discount_pct/100)); === total when the pct is 0
```

### Error responses

| Code | HTTP | When |
|---|---|---|
| `PRICE_BELOW_MINIMUM` | 400 | A stay line's `unit_price` is below the resolved floor. **Existing code, existing status** — reused, not redefined. |
| `VALIDATION_ERROR` | 400 | A stay line's `unit_price` exceeds `quote.total`; or `max_discount_pct` outside `[0, 100]`. |

## Frontend

Design system: `.design/design-system/DESIGN_TOKENS.md`.

- **`features/catalog/components/UnitFields.tsx`** — one percent field, *«Descuento máximo»*, next
  to *Comisión*. This file is the single definition consumed by **both** the wizard's
  `UnitDraftSheet` and the detail page's `UnitFormSheet`, so create and edit are covered once.
  Helper text names the consequence: *«0 % = sin descuento»*.
- **`store/posCart.ts`** — `AddStayInput` and `StayCartLine` gain `min_total`; a new
  `setStayTotal(id, total)` writes `total`. No invalidation logic (D5).
- **`features/pos/components/StayCartLine.tsx`** — when `min_total < quoted_total` the total
  becomes editable. When they are equal the component renders exactly what it renders today (D7).
  *(**Revised by D12** — the field is the shared `EditableMoney`, not a `TextField` beside a
  `MoneyText`.)*
- **`features/pos/components/LodgingStaySheet.tsx`** — passes `quoted.min_total` through to
  `addStayLine`. It is the only builder of a stay line, so both catalog entry paths (range-first
  US-AG36 and type-first US-AG37) are covered by this one call site.
- **`services/posService.ts`** — sends `unit_price` on a stay line only when it differs from the
  quote, keeping the payload byte-identical for an undiscounted sale.

**«Cobrar» is not gated on line validity, deliberately (D13).** An earlier draft of this section
promised that a below-floor stay line would disable the button "the same way a below-minimum tour
line does". Neither half was true: `canSubmit` reads name, phone, email, reference and the amount
state, and no line at all — for tours either. The gate is also unnecessary. `EditableMoney` clamps
on blur before calling its owner, so no surface can put an out-of-band price into the store; the
error state exists to explain *why the number moved*, not to guard a submit. Recorded rather than
deleted, so a later reader knows it was examined and found redundant, not skipped.

## Scenarios

### US-A92 — An admin caps how far a unit may be discounted

**S-1 — The ceiling saves and comes back**
Given an active unit type with `max_discount_pct = 0`
When the admin PUTs it with `max_discount_pct: 10`
Then `200`, and a subsequent GET returns `max_discount_pct: 10`.

**S-2 — Out of range is refused**
Given an active unit type
When the admin PUTs `max_discount_pct: 101`
Then `400 VALIDATION_ERROR`, and the stored value is unchanged.

**S-3 — Existing units are born at zero**
Given a unit type created before this migration
When it is read after the migration runs
Then `max_discount_pct` is `0` and no row required an `UPDATE`.

### US-AG57 — An agent discounts a stay down to that ceiling

**S-4 — A discount inside the ceiling sells**
Given a unit type with `max_discount_pct = 10` whose quote for the requested range, rooms and
guests is `200000`
When the agent confirms that stay line with `unit_price: 185000`
Then `201`; the line stores `base_price 200000`, `unit_price 185000`, `line_total 185000`,
`minimum_price 180000`; and the folio's `discount_total` is `15000`.

**S-5 — A centavo below the floor is refused**
Given the same unit type and quote (floor `180000`)
When the agent confirms with `unit_price: 179999`
Then `400 PRICE_BELOW_MINIMUM`; no folio, no line, and no per-night inventory is reserved.

**S-6 — The floor rounds toward the operator**
Given a unit type with `max_discount_pct = 10` whose quote is `199999`
When the agent confirms with `unit_price: 179999`
Then `400 PRICE_BELOW_MINIMUM` — the floor is `ceil(179999.1) = 180000`, so `180000` is the first
accepted value.

**S-7 — Above the quote is refused**
Given a quote of `200000`
When the agent confirms with `unit_price: 200001`
Then `400 VALIDATION_ERROR`; the folio is not written.

**S-8 — A zero ceiling admits only the quote**
Given a unit type with `max_discount_pct = 0` and a quote of `200000`
When the agent confirms with `unit_price: 199999`
Then `400 PRICE_BELOW_MINIMUM`; and confirming with `200000` — or with `unit_price` omitted —
returns `201` with `discount_total: 0`.

**S-9 — Omitting the price is byte-identical to today**
Given any unit type, discountable or not
When the agent confirms a stay line with no `unit_price`
Then the stored `base_price`, `unit_price`, `line_total` and `commission_amount` equal what the
same payload produced before this feature, and `minimum_price` is the resolved floor.

**S-10 — A multi-room discount is counted once**
Given a two-room stay quoting `400000` on a unit with `max_discount_pct = 10`
When the agent confirms with `unit_price: 385000`
Then `discount_total` is `15000` — not `30000` (D9).

**S-11 — A fixed commission never exceeds the discounted line**
Given a unit type with a `fixed` commission of `100000` per room-stay and `max_discount_pct = 50`,
and a one-room stay quoting `150000`
When the agent confirms with `unit_price: 75000`
Then the folio's `commission_amount` is `75000`, not `100000`.

**S-12 — The floor travels with the quote**
Given a unit type with `max_discount_pct = 10`
When the agent requests `GET /api/pos/lodging/:serviceId/availability` for a range whose quote is
`200000`
Then that type's entry carries `total: 200000` and `min_total: 180000`; and for a unit with
`max_discount_pct = 0`, `min_total` equals `total`.

**S-13 — An affiliate is bound by the same floor**
Given an affiliate whose allow-list includes the parent lodging service, and a floor of `180000`
When the affiliate confirms the stay line with `unit_price: 179999`
Then `400 PRICE_BELOW_MINIMUM` — the same code, status and message an agent gets.

### Multitenancy isolation (required)

**S-14 — Another org's unit type is invisible to the discount path**
Given two organizations seeded with `seedTwoOrgs`, each owning a lodging service with one unit type
When org A confirms a stay line naming org B's `unit_type_id`, with any `unit_price`
Then `404` — never `403`, which would confirm the type exists, and never a price error, which
would leak that org B's floor was evaluated.

**S-15 — Another org's ceiling cannot be set**
Given the same two organizations
When org A PUTs `max_discount_pct` on org B's unit type
Then `404`, and org B's stored value is unchanged.

## Definition of Done

- [x] Migration `0066_unit_max_discount.sql` + `maxDiscountPct` on `accommodationUnitTypes`
- [x] `max_discount_pct` accepted, validated `[0, 100]`, persisted and returned on unit-type create/update
- [x] `min_total` on the POS lodging availability payload
- [x] `unit_price` optional on `stayLineSchema`; floor, ceiling, snapshot (D8), `discount_total` (D9) and commission clamp (D10) in the confirm handler
- [x] Scenarios S-1 – S-13 covered, in `api-turistear/test/pos/stay-discount.test.ts` — 19 tests, incl. `stayFloor` unit cases and S-11b (a fixed commission that fits is untouched)
- [x] Cross-org isolation tests (S-14, S-15) using `seedTwoOrgs`
- [x] Frontend: `UnitFields`, `posCart`, `StayCartLine`, `LodgingStaySheet`, `posService`, plus `schemas.ts` / both unit-form hosts / `useCreateLodgingFull`
- [x] `docs/lodging/accommodation-stays.spec.md`: the deferred-discount line and the § 5 commission exemption annotated as superseded here — not deleted
- [x] `SPEC.md`: US-A92, US-AG57, the Features-by-Phase line, glossary term *Descuento máximo (stay)*

**Follow-up shipped separately (D12/D13).** `components/EditableMoney.tsx` — the shared
editable-money primitive — plus the migration of all three POS price surfaces onto it, the
`cartDiscountTotal` fix below, and the tour line total moving into the meta as `2 × $200.00 =
$400.00`. Reported from use: the stay's total had become a raw `1200` in a bordered box, with no
money read anywhere on the line.

**Bug found and fixed in that follow-up.** `cartDiscountTotal` (`store/posCart.ts`) returned `0`
for every stay line, so the checkout's «Descuento» row disagreed with the `discount_total` the
server persists under D9 — the client simply never looked at stays. `posCart.test.ts` had *pinned*
that zero as intended behaviour; the assertion is rewritten, not deleted.

**Verification.** API 970 green (was 960); frontend 595 green (was 587); `build:api`, `build:app`
clean; `lint:app` 0 errors. The three defect fixes were mutation-tested: reverting D8, D9 and D10
in `pos/handler.ts` fails S-4, S-8, S-9, S-10 and S-11, so those scenarios *detect* the defects
rather than describe them.

**Scope-boundary deviation, recorded rather than quietly absorbed.** The boundary named
`test/lodging/` and `test/pos/pos-controlled-discount.test.ts` as passing unedited, and both do.
But `src/store/posCart.test.ts` **was** edited: `StayCartLine` gained two required fields, so the
test's `stayLine()` factory and one `addStayLine` call had to seed them. Both edits give the new
fields the undiscounted values (`min_total === quoted_total === total`), so no existing assertion
changed meaning. `src/features/catalog/schemas.test.ts` passes unedited only because
`max_discount_pct` is `.optional()` rather than required — see D11.

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| A per-night discount (the agent shaves one Saturday, not the stay) | The whole-line total is what the counter negotiates. Per-night would need the discount to survive the seasonal/weekend precedence night by night, and no one has asked. |
| A service- or org-level default the units inherit (`type override ?? property`) | The waterfall shape is already proven by commission, so it drops in without moving anything decided here. An operator with many units types the number more than once until then. |
| Re-validating the floor when a stay is **rescheduled** to different dates | Reschedule re-quotes and the snapshotted `minimum_price` (D8) is now truthful for the line as sold, so the number exists the day someone wants to enforce it. Today reschedule does not re-price a stay at all — that is its own decision, not this one's. |
| A discount **reason** or approval trail | Tours have none either. Adding it to one side only would make the two paths diverge for no reported need. |

## Known behaviour change

**None, until an admin acts.** The migration lands `max_discount_pct = 0` on every existing unit
type, at which point rules 1 and 2 admit exactly the quoted total — the only price the product can
produce today. No org's totals, commissions or `discount_total` move on deploy.

Two numbers change *for stays sold after an admin sets a non-zero percent*:

- `folio_lines.minimum_price` stops being `0` and starts carrying the floor. Anything reading that
  column for a stay was reading a placeholder; it now reads a fact. No existing reader branches on
  it for stay lines.
- `folios.discount_total` becomes non-zero for stays for the first time. Reports that summed it
  were summing tours only, and will now include lodging — correctly, and only where a discount was
  actually given.

## Open

- **Should the ceiling be visible to the agent as a percent, or only as a floor in pesos?** The
  spec shows only *«Mínimo $X»* (D6), which is what the agent needs to close the sale. The smallest
  change if operators ask for it: send `max_discount_pct` alongside `min_total` and render it in
  the helper text — no server logic moves.
- **Should a unit's percent be capped by anything at authoring time?** `100` is accepted, which
  means "give it away". A fixed commission is protected by D10, but nothing stops an admin from
  authorizing a free stay. The smallest change: a second refine on the unit-type schema with an
  org-level maximum — one column, no new concept.
