# Feature: POS Line Discounts and Minimum Price Enforcement

## Context

Currently, the POS cart silently clamps tour prices to their `minimum_price` instead of letting the agent see they've entered a below-minimum value. Furthermore, lodging (v2 unit types) calculates its total entirely from the server's per-night rate and does not allow manual price overrides (discounts) at all, nor does the database store a minimum price floor for lodging. Agents need the ability to discount both tours and lodging in the cart, while the system visibly but strictly enforces minimum price floors.

## Scope boundary

This feature must NOT change the server-side calculation of `line_total` for lodging when no override is provided. It must NOT change the fact that POS cart entries are aggregated to a final total. The existing database rows for `lodging_unit_types` must remain valid by defaulting the new `minimum_nightly_rate` to `nightly_rate` (no discount allowed by default for existing units).

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | Discounts are applied individually per service line in the cart, not globally. | Allows granular control and independent validation against each service's price floor. |
| **D2** | Lodging gets a new `minimum_nightly_rate` DB column. | Brings lodging in line with tours, giving admins a way to define a discount floor. |
| **D3** | Lodging discounts are entered by overriding the total price of the stay line. | Lodging lines group multiple rooms and nights. Overriding the line total is simpler for the agent than mathing out a per-night discount, and we can easily validate `total >= minimum_nightly_rate * nights * quantity`. |
| **D4** | Cart inputs no longer silently clamp to minimum; instead they show an alert and block the sale. | Silent clamping hides the constraint from the user. A visible validation error makes it clear why the price didn't change or why they can't proceed. |

## Data Model

### Migration `XXXX_add_lodging_minimum_rate.sql`

```sql
ALTER TABLE lodging_unit_types ADD COLUMN minimum_nightly_rate integer;
UPDATE lodging_unit_types SET minimum_nightly_rate = nightly_rate WHERE minimum_nightly_rate IS NULL;
ALTER TABLE lodging_unit_types ALTER COLUMN minimum_nightly_rate SET NOT NULL;
```

*The frontend cart state (`PosCartState`) will stop clamping `unit_price` in `setUnitPrice` and will add a new `discounted_total` field to `StayCartLine`.*

## Business rules (enforced server-side)

1. A tour line's `unit_price` must be `>= minimum_price`.
2. A lodging stay line's `total` must be `>= minimum_nightly_rate * nights * quantity`.
3. If an explicit total/price is not provided in the request, the server calculates it using the base rate (as it does today).

## Authorization — who may do this

Any agent who can access the POS can apply discounts up to the minimum price floor.

## API surface

### `POST /api/pos/folios`

* Request shape: `StayLineInput` adds an optional `unit_price` (which is used as the total override for stays since `base_price = unit_price = line_total` per schema).
* Server derives: if `unit_price` is sent for a stay, it validates it against the `minimum_nightly_rate * nights * quantity`.

### Error responses

| Code | HTTP | When |
|---|---|---|
| `PRICE_BELOW_MINIMUM` | 422 | A line's provided price falls below its configured minimum. |

## Frontend

* `features/pos/components/CartLine`: Add subtle warning text (amber/red) when the price falls below the minimum.
* `features/pos/hooks/useCartStore`: Remove the math `clamp` in `setUnitPrice`. Add ability to override total for `StayCartLine`.
* The `Confirmar Venta` button is disabled if any line violates the minimum price rule.

## Scenarios

### US-POS01 — Apply discount to a tour

**S-1 — Cart warns and blocks when tour price is below minimum**
Given a tour with base price 1000 and minimum 800
When the agent changes the line price to 700
Then a subtle alert appears under the price field and the Confirm button is disabled.

### US-POS02 — Apply discount to lodging

**S-2 — Agent overrides total stay price**
Given a 2-night stay for 1 room at 1000/night (min 900/night)
When the agent overrides the total from 2000 to 1850 (>= 1800 minimum)
Then the cart total updates and the sale can be confirmed.

### Multitenancy isolation (required)

**S-n — Another org's record is invisible**
Given two organizations seeded with `seedTwoOrgs`
When org A requests org B's record
Then `404` — never `403`, which would confirm it exists.

## Definition of Done

- [ ] Migration + schema
- [ ] Endpoints + validation
- [ ] Scenarios covered, in `test/folios/pos-discounts.test.ts`
- [ ] Cross-org isolation tests
- [ ] Frontend
- [ ] `SPEC.md`: stories, Features by Phase line, glossary
