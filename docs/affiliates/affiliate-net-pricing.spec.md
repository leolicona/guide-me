# Feature: The affiliate owes a net price, not a commission — and the tourist can pay at the counter

> **Status: Draft (2026-08-22).**
> **Stories:** US-A94, US-A95, US-A96, US-AF14, US-AF15.
> **Amends** `docs/affiliates/affiliate-setup-commissions.spec.md` **D1/D2** (the row's *value* stops
> being a commission rate) and **supersedes** `docs/affiliates/affiliate-portal.spec.md` **D3** and
> its *Out of scope* line — *"Affiliate-negotiated net prices (sells at the operator's price;
> margin = commission)"* — which this feature deliberately reverses.
> **Amends** US-A50 / US-A56 (the captured unit changes; the allow-list mechanic does not).
> **Depends on:** `affiliate-setup-commissions.spec.md` (companies, allow-list, invitations,
> attribution) · `affiliate-operators.spec.md` (the token link + PIN shift) ·
> `pos/express-sale.spec.md` (the one-sheet sale this feature prices) ·
> `pos/pos-controlled-discount.spec.md` (`confirmSale`, the atomic decrement).

---

## Context

The affiliate model shipped assuming the reseller sells **at our price** and earns **a commission we
configure**. The business does the opposite, and has been doing it for as long as affiliates have
existed: the hotel is quoted a **net price per person** — what it owes us — and whatever it charges
the tourist above that is its own margin, negotiated in its own lobby, with a price list we never see.

The gap is not cosmetic. It makes three real situations unrepresentable:

| # | What happens in the field | What the system can record today |
|---|---|---|
| **A** | The hotel sends 10 tourists **with no deposit**. They pay in full at our counter. | Nothing. A folio needs money to exist (below), so the seats are not held — the group arrives to a full departure. |
| **B** | The hotel sells 10 seats and **collects the whole amount itself**. | A sale at *our* price, with *our* commission. The $110/seat actually agreed is not a number the system holds. |
| **C** | The tourist leaves a deposit **with the hotel** and pays the rest **at our counter**. | The deposit half only. The counter half credits the wrong caja (below). |

Three concrete defects underlie that table.

**1 — A hold with no money is unexpressable.** `booking_min_down_payment_pct` defaults to `0`, which
reads as "a zero deposit is allowed", but the API contract disagrees:

```ts
down_payment: z.number().int().min(1).optional()   // pos/schema.ts:89
const isBooking = input.down_payment != null       // pos/handler.ts:1431
```

The field carries **two** meanings on one axis — *how much* and *which kind of sale* — so `0` fails
validation and *absent* means "paid in full". **Case A cannot be written at all.** The seats the
hotel promised are not held, and the overbooking guard that `pos-controlled-discount.spec.md` calls
the integrity-critical operation never runs, because no sale was ever confirmed.

**2 — The margin is credited to whoever touched the cash.** The running balance sums commission by
`folio_payments.collected_by` (`cash/handler.ts:206, 216`). In cases A and C the money is taken by
**our** counter, so the hotel's margin would accrue to **our cashier's caja**. The ledger already
distinguishes the two ideas — `commissionRow.collectedBy` is documented as *"the agent/manager whose
caja earns it"*, not who handed over the cash — but the sale path passes the same user into both.

**3 — One org-wide deposit policy for two different relationships.** Relaxing
`booking_min_down_payment_pct` to `0` so hotels can hold seats without money also lets **every field
agent** hold seats without collecting anything. The lever exists; it is aimed at the wrong scope.

What is *not* broken is the settlement arithmetic. The running balance already computes all three
cases correctly the moment the margin is the right number credited to the right caja:

```
debt = (what the affiliate collected) − (its margin) − (confirmed deposits)
```

| Case | Collected by affiliate | Margin | Debt | Meaning |
|---|---|---|---|---|
| **A** | $0 | $200 | **−$200** | we owe the hotel — nets against its next sales |
| **B** | $1,300 | $200 | **$1,100** | the hotel owes us its net price |
| **C** | $500 | $200 | **$300** | partial each way |

Net price ($110) and fixed commission ($20 off a $130 sale) are **the same algebra seen from two
sides** — `commission = sale_price − net_price`. This feature changes the unit the admin captures
and the caja the margin lands in. It does not add a settlement path, a balance, or a ledger.

---

## Scope boundary

Stated so a machine can check it:

1. **`test/cash/agent-balance-cash-drops.test.ts` and `test/folios/folio-cancellation.test.ts` must
   pass unedited.** No money path changes. The margin's *value* and its *`collected_by`* change;
   the rows, their signs, and their reversal semantics do not.
2. **A sale with no affiliate is byte-identical.** Every `POST /api/pos/folios` body valid today
   produces the same folio, the same lines, the same ledger rows. `sale_type` (D7) is optional and
   its absence reproduces today's `down_payment` semantics exactly.
3. **`affiliate_commissions` rows without `net_price` behave as they do today** — the percent/fixed
   rate still resolves. There is no flag day; the two pricing modes coexist per row (D1).
4. **No new table, no new balance, no second ledger.** The feature adds columns to two existing
   tables and one nullable snapshot column to `folio_lines`.

---

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | The allow-list row gains `net_price`; when it is set, the row is priced **net** and its `commission_type`/`commission_value` are ignored. Rows without it keep today's rate. | Net price and fixed commission are the same algebra (`commission = sale − net`), so this is a change of captured unit, not of model. Per-row coexistence removes the flag day and keeps scope boundary #3 mechanical. |
| **D2** | `net_price` **may be below** the service's `minimum_price`. | Volume partners are quoted under the public floor — that is the whole commercial point. The alternative (an exception that lets affiliates sell below the floor) would weaken the floor for everyone; a separate negotiated number weakens nothing. |
| **D3** | `max_price` caps what an affiliate may charge **on a folio it did not fully collect**. Enforced server-side. | In cases A and C **our** counter collects that price under **our** name. Uncapped, we would take mostly-not-ours money from a tourist who believes we charged it — a reputational and invoicing exposure. Case B (the affiliate collects) is unaffected in practice, but the cap is enforced uniformly because the case is not known at confirm time (a $0 hold may settle either way). |
| **D4** | The margin is **derived**, never configured: `commission_amount = line_total − (net_price × quantity)`, floored at 0. | One source of truth. A stored margin could disagree with the line it describes — exactly the class of defect `folio-state-machine.spec.md` traced to information lost across two representations. |
| **D5** | On a net-priced line the commission row is written with `collected_by = folios.agent_id` (the affiliate manager), regardless of who took the money. | The field already means *"whose caja earns it"*. Without this, defect #2 stands: our counter's cashier accrues the hotel's margin and both cajas are wrong. |
| **D6** | `booking_min_down_payment_pct` and `booking_grace_offset_minutes` become **overridable per affiliate company**; `NULL` inherits the org value. | Defect #3. Overriding per affiliate relaxes the rule exactly where the relationship justifies it and nowhere else. |
| **D7** | `POST /api/pos/folios` gains an explicit `sale_type: 'paid' \| 'booking'`; with it, `down_payment` accepts `0`. Absent, today's absent-vs-present rule applies unchanged. | Defect #1. Patching `min(1)` → `min(0)` alone would leave `0` and *absent* meaning different things by accident — an ambiguity nobody remembers six months later. An explicit discriminator makes the $0 hold expressible and keeps scope boundary #2. |
| **D8** | The **primary** capture surface is the operator's token link + PIN + Express Sale, not admin capture. | All three parts already ship (US-AF10/OP01/OP02, US-AG45). Routing every affiliate sale through one admin makes that admin the throughput ceiling for every partner, and the usual justification — distrusting the price — does not apply when the affiliate sets the price by design. |
| **D9** | Admin capture on an affiliate's behalf ships as a **fallback** surface (US-A95), not the main path. | Some partners will not adopt the link. The cost is one admin-only screen reusing the same endpoint, not a second sale path. |
| **D10** | The counter finds the folio **by phone** (`folioSearch`, already digit-normalised). A short presentable code is **deferred**. | Zero code today. The code is only needed when a party registered under the guide's phone arrives split up — a real but narrower case, and one that should be solved together with the already-deferred QR short-link rather than inventing a second short-code scheme. |
| **D11** | A tourist with **no folio** pays the **public price** as an ordinary walk-up; no affiliate attribution is created at the counter. | Without a folio there is no seat held and no agreed price. A hard rule removes counter-side ambiguity and makes reporting the sale the affiliate's own interest. |
| **D12** | Cases A/B/C are **one flow** — one folio, differing only in `down_payment` and who collected. Counter payment is the existing `settle`, not a new sale. | The apartado, its settle, its per-line clock and its search already ship. Modelling the counter half as a new sale would duplicate inventory and money paths for no new behaviour. |
| **D13** | `net_price` is **snapshotted** on `folio_lines` at confirm time. | Renegotiating a partner's price must never rewrite what past sales owed — the same snapshot rule every other money input in this codebase follows. |
| **D14** | The table keeps the name `affiliate_commissions`. | Renaming touches every reader for no behavioural gain. The misnomer is recorded in `TECH_DEBT.md` instead of paid for in churn. |

---

## Data Model

### Migration `0067_affiliate_net_pricing.sql`

```sql
-- US-A94 — the affiliate agreement stops being a commission rate and becomes a net price plus a
-- ceiling. Additive: the existing commission columns stay and still resolve for any row that has
-- no net_price (D1), so no row changes behaviour on the day this lands.

ALTER TABLE affiliate_commissions ADD COLUMN net_price INTEGER;   -- minor units per spot; NULL = rate-priced
ALTER TABLE affiliate_commissions ADD COLUMN max_price INTEGER;   -- minor units per spot; NULL = no ceiling

-- Deterministic backfill (the 0049/0061 pattern). A `fixed` rate IS a net price expressed from the
-- other side, so it converts exactly. A `percent` rate has no fixed net equivalent — it depends on
-- a sale price that does not exist yet — so those rows keep their rate and stay rate-priced (D1).
UPDATE affiliate_commissions
   SET net_price = (SELECT s.base_price - affiliate_commissions.commission_value
                      FROM services s WHERE s.id = affiliate_commissions.service_id),
       max_price = (SELECT s.base_price FROM services s WHERE s.id = affiliate_commissions.service_id)
 WHERE commission_type = 'fixed';

--> statement-breakpoint
-- US-A94 (D6) — per-affiliate booking policy. NULL inherits the organization's value, so an
-- existing company behaves exactly as it does today.
ALTER TABLE affiliate_companies ADD COLUMN booking_min_down_payment_pct INTEGER;
ALTER TABLE affiliate_companies ADD COLUMN booking_grace_offset_minutes INTEGER;

--> statement-breakpoint
-- D13 — the net price this line was sold under. NULL for every non-affiliate and rate-priced line,
-- which is every line that exists before this migration.
ALTER TABLE folio_lines ADD COLUMN affiliate_net_price INTEGER;
```

### Drizzle columns

```ts
// affiliateCommissions
netPrice: integer('net_price'),   // minor units PER SPOT the affiliate owes us. NULL ⇒ rate-priced (D1)
maxPrice: integer('max_price'),   // minor units PER SPOT ceiling on the sold unit price. NULL ⇒ uncapped

// affiliateCompanies
bookingMinDownPaymentPct: integer('booking_min_down_payment_pct'), // NULL ⇒ inherit org (D6)
bookingGraceOffsetMinutes: integer('booking_grace_offset_minutes'), // NULL ⇒ inherit org (D6)

// folioLines
affiliateNetPrice: integer('affiliate_net_price'), // snapshot; the margin is derived from it (D4/D13)
```

**Authoritative vs derived.** `net_price` on the line is the authoritative snapshot.
`folios.commission_amount` and the `commission` ledger rows remain roll-ups **derived** from it at
confirm time (D4) and are never recomputed afterwards — identical to how every other commission in
this codebase behaves.

---

## Business rules (enforced server-side)

1. A `affiliate_commissions` row with `net_price` set is **net-priced**; its `commission_type` /
   `commission_value` are ignored for pricing. A row without it resolves the rate exactly as today.
2. `net_price > 0`. It **may** be below the service's `minimum_price` (D2) and is **not** bound by
   the public discount floor in either direction.
3. When `max_price` is set, `max_price >= net_price`. Rejected at configuration time.
4. On a net-priced line, `unit_price` must satisfy `net_price <= unit_price <= max_price`
   (the upper bound only when `max_price` is set). The public `minimum_price` floor **does not
   apply** to a net-priced line — its floor is the net price.
5. The line's margin is `max(0, line_total − net_price × quantity)` (D4). The frontend mirrors this
   for live feedback; the server value is the one written.
6. On a net-priced line the `commission` ledger row is written with
   `collected_by = folios.agent_id` — the affiliate manager — whatever `folio_payments.collected_by`
   the money row carries (D5).
7. `sale_type: 'booking'` permits `down_payment = 0`. `sale_type: 'paid'` requires
   `down_payment` absent. When `sale_type` is absent, today's rule applies unchanged: present ⇒
   booking, absent ⇒ paid (D7, scope boundary #2).
8. The deposit minimum for a folio attributed to an affiliate company resolves
   `affiliate_companies.booking_min_down_payment_pct ?? organizations.booking_min_down_payment_pct`.
   The grace offset resolves the same way (D6).
9. A `$0` hold **decrements inventory identically to any other sale** — the atomic conditional
   decrement is unchanged. It is a held seat, not a lesser one.
10. A net-priced line's `affiliate_net_price` is snapshotted at confirm. Later agreement edits never
    rewrite a sold line (D13).
11. Settling a folio at the counter (US-A96) writes the money row with `collected_by` = the counter
    user and leaves the already-accrued margin untouched (rules 5–6 ran at confirm).
12. A service whose allow-list row is net-priced but whose `net_price` exceeds the sold
    `unit_price` is rejected at confirm — the affiliate may not sell below what it owes.

---

## Authorization — who may do this

| Capability | Role | Bound |
|---|---|---|
| Configure the agreement (US-A94) | `admin` | Own org. A foreign `affiliate_company_id` or `service_id` → **404** (never 403 — it would confirm existence). |
| Sell at the affiliate's net price (US-AF14/AF15) | `affiliate` manager, or an `affiliate_operators` PIN shift borrowing that identity | Only services on **their own** company's allow-list. A non-allow-list `service_id` → `403 SERVICE_NOT_ALLOWED` (existing defence in depth). |
| Capture on an affiliate's behalf (US-A95) | `admin` | Own org; must name an affiliate company in the org. |
| Settle at the counter (US-A96) | `admin` or `agent` | Any folio in their org, affiliate-attributed or not. Unchanged from today's settle authorization. |

Multitenancy Rule 1 holds throughout: no `organization_id` is accepted in any body.

---

## API surface

### `PUT /api/affiliates/:id/commissions` *(amended)*

The bulk allow-list upsert (US-A50) gains the two pricing fields. The array is still the full
desired set — a service absent from it is disabled.

```jsonc
[
  { "service_id": "svc_1", "net_price": 11000, "max_price": 18000 },   // net-priced (D1)
  { "service_id": "svc_2", "commission_type": "percent", "commission_value": 1500 } // rate-priced
]
```

Server-derived and refused from the body: `organization_id`, `affiliate_company_id`, `id`,
timestamps. Exactly one of `net_price` or `commission_type`+`commission_value` must be present per
entry.

### `PUT /api/affiliates/:id` *(amended)*

Accepts the two nullable policy overrides (D6). `null` restores inheritance from the org.

```jsonc
{ "name": "Hotel X", "booking_min_down_payment_pct": 0, "booking_grace_offset_minutes": -30 }
```

### `POST /api/pos/folios` *(amended)*

Gains `sale_type` (D7). `down_payment` accepts `0` **only** with `sale_type: 'booking'`.
Gains `on_behalf_of_affiliate_company_id` for US-A95 — **admin only**, rejected for any other role,
and refused when the caller is themselves an affiliate.

### `GET /api/pos/services` *(amended)*

For an affiliate caller, each curated service carries `net_price` and `max_price` so the sheet can
show the seller their floor, their ceiling and their live margin (D-visibility, US-AF14).

### Error responses

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `net_price <= 0`; `max_price < net_price`; both pricing modes on one entry; neither on one entry; `down_payment: 0` without `sale_type: 'booking'`; `down_payment` present with `sale_type: 'paid'` |
| `PRICE_BELOW_NET` | 400 | A net-priced line's `unit_price < net_price` (rule 12) |
| `PRICE_ABOVE_MAX` | 400 | A net-priced line's `unit_price > max_price` (rule 4) |
| `SERVICE_NOT_ALLOWED` | 403 | Existing — a non-allow-list service for an affiliate caller |
| `FORBIDDEN` | 403 | `on_behalf_of_affiliate_company_id` sent by a non-admin |
| `NOT_FOUND` | 404 | A foreign or unknown affiliate company / service id (cross-org isolation) |

---

## Frontend

Design system: `.design/design-system/DESIGN_TOKENS.md`. No new token, no new primitive.

| Screen | Change |
|---|---|
| `AffiliateDetailPage` → `CommissionsSheet` | The per-service editor swaps the *Percentage / Fixed* segmented toggle for **Precio neto** + **Precio máximo** inputs on a net-priced row. Reuses `MoneyText` and the existing `CommissionCatalogEditor` row layout. |
| `AffiliateWizard` step 2 | Same editor component — the wizard's step 2 already delegates to `CommissionCatalogEditor`, so it inherits the change. |
| `CompanyInfoSheet` | Gains the two policy overrides (D6) with an explicit *«Usar el valor de la organización»* state for `NULL`. `FormSheet` host, unchanged. |
| Express Sale sheet (affiliate caller) | Unit price becomes editable within `[net_price, max_price]`, with the seller's **live margin** shown beside it (`MoneyText`, semantic neutral — never teal, per the money rule). Shows both numbers: the affiliate negotiated them, so there is nothing to withhold. |
| Express Sale sheet | A **«Sin anticipo»** option that confirms with `sale_type: 'booking'`, `down_payment: 0` (US-AF15). |
| New: admin capture (US-A95) | The existing POS with an affiliate selector in the checkout. No new route — `/pos` with an admin-only `SectionCard` naming the company the sale is attributed to. |
| Counter settle (US-A96) | Unchanged UI. The existing folio search + *Liquidar* already covers it; the margin credit is server-side. |

`commission.ts` in `features/affiliates/` gains net-price conversion beside the existing
display↔storage helpers; `draftToEntries` emits whichever pricing mode a row carries.

---

## Scenarios

### US-A94 — the admin configures the agreement

**S-1 — A net price below the public floor is accepted**
Given a service with `minimum_price = 13000`
When the admin sets that service's affiliate `net_price = 11000`
Then it saves, and the service's own `minimum_price` is unchanged.

**S-2 — A ceiling below the net price is rejected**
Given `net_price = 11000`
When the admin sets `max_price = 9000`
Then `400 VALIDATION_ERROR`, and no row is written.

**S-3 — Both pricing modes on one entry is rejected**
Given an entry carrying `net_price` **and** `commission_type`
When it is submitted
Then `400 VALIDATION_ERROR` — the row's mode must be unambiguous (D1).

**S-4 — Clearing an override restores inheritance**
Given a company with `booking_min_down_payment_pct = 0` and an org value of `30`
When the admin sets it to `null`
Then the next booking for that company requires 30%.

### US-AF14 — the affiliate seller sells within its range

**S-5 — A price inside the range sets the derived margin**
Given `net_price = 11000`, `max_price = 18000`, and a sale of 10 spots at `unit_price = 13000`
When the manager confirms
Then `line_total = 130000`, `affiliate_net_price = 11000` is snapshotted,
and the folio's `commission_amount = 130000 − 110000 = 20000`.

**S-6 — Below the net price is refused**
When the same seller confirms at `unit_price = 10500`
Then `400 PRICE_BELOW_NET` — the affiliate may not sell for less than it owes (rule 12).

**S-7 — Above the ceiling is refused**
When the same seller confirms at `unit_price = 19000`
Then `400 PRICE_ABOVE_MAX` (rule 4).

**S-8 — The public floor does not bind a net-priced line**
Given the service's `minimum_price = 13000` and `net_price = 11000`
When the seller confirms at `unit_price = 12000`
Then the sale succeeds — a net-priced line's floor is its net price, not the public floor (D2).

**S-9 — An operator shift sells into the manager's caja**
Given an `affiliate_operators` PIN shift for that company
When the operator confirms the S-5 sale
Then `folios.agent_id` is the **manager**, `folios.operator_id` is the operator,
and the manager's balance — not the operator's — carries the margin (US-A68, unchanged).

### US-AF15 — a hold with no deposit

**S-10 — A $0 hold is written and holds the seats**
Given a slot with `capacity 50, booked 0`
When the affiliate confirms 10 spots with `sale_type: 'booking'`, `down_payment: 0`
Then the folio exists with `amount_paid = 0`, `slots.booked = 10`,
and every line carries its own `booking_expires_at`.

**S-11 — `down_payment: 0` without the discriminator is still rejected**
When the same body omits `sale_type`
Then `400 VALIDATION_ERROR` — today's contract is untouched (scope boundary #2, D7).

**S-12 — The affiliate's grace override decides the release**
Given the org grace is `+15` and the company's override is `−30`
When the departure passes by 20 minutes with the hold unsettled
Then the seats are **still held** — the company's override won (D6).

### US-A96 — the counter settles an affiliate folio

**S-13 — The counter collects; the hotel keeps the margin**
Given the S-10 folio, `net_price = 11000`, sold at `unit_price = 13000`
When our counter user settles it for `130000` in cash
Then the money row carries `collected_by` = the **counter user**,
the `commission` row carries `collected_by` = the **manager** (D5),
our counter's balance rises by `130000`,
and the affiliate's balance is `−20000` — we owe the hotel its margin.

**S-14 — The affiliate collected it all**
Given the same agreement, sold and paid in full **by the manager**
Then the affiliate's balance is `130000 − 20000 = 110000` — exactly its net price × quantity.

**S-15 — A tourist with no folio gets the public price**
Given no folio matches the tourist's phone
When the counter sells them a walk-up seat
Then the folio has `affiliate_company_id = null` and the public price applies (D11).

### US-A95 — admin capture on an affiliate's behalf

**S-16 — The sale lands in the affiliate's caja, not the admin's**
When an admin confirms a sale with `on_behalf_of_affiliate_company_id`
Then `folios.agent_id` is that company's manager and `affiliate_company_id` is the company —
the admin's own caja is untouched.

**S-17 — Only an admin may capture on behalf**
When an `agent` or `affiliate` sends `on_behalf_of_affiliate_company_id`
Then `403 FORBIDDEN`.

### Regression — the feature is invisible without it

**S-18 — A rate-priced row is unchanged**
Given an allow-list row with `commission_type='percent'`, `commission_value=1500`, no `net_price`
When an affiliate sells it
Then the commission is `round(line_total × 1500 / 10000)`, byte-identical to today (D1).

**S-19 — A non-affiliate sale is unchanged**
When an agent confirms any sale valid today
Then the folio, its lines and its ledger rows are identical to the pre-feature result
(scope boundary #2).

### Multitenancy isolation (required — `seedTwoOrgs`)

**S-20 — Another org's affiliate company is invisible**
When org A configures an agreement for org B's `affiliate_company_id`
Then `404` — never `403`, which would confirm it exists.

**S-21 — A net price may not be set on a foreign service**
When org A sets `net_price` for a `service_id` belonging to org B
Then `404`, and no row is written.

**S-22 — Admin capture cannot name a foreign company**
When org A's admin sends org B's `on_behalf_of_affiliate_company_id`
Then `404`.

---

## Definition of Done

### Phase 1 — the agreement (migration `0067`)

- [ ] Migration `0067_affiliate_net_pricing.sql` + Drizzle columns
- [ ] `PUT /api/affiliates/:id/commissions` accepts both pricing modes; `PUT /api/affiliates/:id` accepts the policy overrides
- [ ] S-1 … S-4, S-20, S-21 in `test/affiliates/affiliate-net-pricing.test.ts`
- [ ] `CommissionsSheet` / `CommissionCatalogEditor` / `CompanyInfoSheet` updated; verified with `pnpm build:app`
- [ ] `SPEC.md`: US-A94 + Features-by-Phase line + glossary (*net price*, *price ceiling*)

### Phase 2 — selling at the net price

- [ ] `confirmSale` resolves the net price, enforces rules 4/12, derives the margin (D4)
- [ ] The commission row is written with `collected_by = agent_id` on a net-priced line (D5)
- [ ] `GET /api/pos/services` returns `net_price` / `max_price` for an affiliate caller
- [ ] S-5 … S-9, S-18, S-19 covered
- [ ] Express Sale shows floor, ceiling and live margin

### Phase 3 — the $0 hold and the counter

- [ ] `sale_type` discriminator; `down_payment: 0` (D7)
- [ ] Per-affiliate deposit + grace resolution (D6)
- [ ] S-10 … S-15 covered
- [ ] «Sin anticipo» in the Express sheet

### Phase 4 — admin capture (fallback)

- [ ] `on_behalf_of_affiliate_company_id`, admin-only
- [ ] S-16, S-17, S-22 covered
- [ ] Affiliate selector in the admin POS checkout
- [ ] `SPEC.md` boxes ticked on merge; deferrals moved to `TECH_DEBT.md`

---

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **Short presentable code for the counter** (D10) | `folioSearch` already finds a folio by phone digits, which covers the common case. The code is only needed when a party registered under one phone arrives split up — and it should be solved once, together with the already-deferred QR short-link, rather than as a second short-code scheme. |
| **Renaming `affiliate_commissions`** (D14) | The name is wrong the day `net_price` lands, but renaming touches every reader for no behavioural gain. Recorded in `TECH_DEBT.md`; the column comments carry the truth in the meantime. |
| **Per-affiliate seat allotment** | Rejected for now, not forgotten: a $0 hold could in principle block a departure. The per-affiliate grace override (D6) already bounds the exposure in time, and no partner has abused it. If one does, the allotment is additive. |
| **WhatsApp Cloud API for capture** | Considered and declined: a conversational flow cannot show live per-slot availability or take the atomic decrement, both of which the token link already does. Cloud API for *delivery* is a real improvement and already has its own spec (`docs/whatsapp-qr-delivery/`). |
| **Converting `percent` rows to net prices** | No deterministic conversion exists (the migration comment says so). Those rows keep working under D1; the admin recaptures them when the partner is renegotiated. |

---

## Known behaviour change

- **Existing affiliate `fixed` rows are re-expressed as net prices** by the backfill:
  `net_price = base_price − commission_value`, `max_price = base_price`. The money owed is
  identical — the same number seen from the other side — but the admin screen will show *Precio
  neto $110* where it previously showed *Comisión $20*. **In this deployment the affected set is one
  company registered and never sold against**, so no production figure moves.
- **`percent` affiliate rows are untouched** and keep computing exactly as today.
- **Nothing changes for agents, admins, or non-affiliate sales.** The `booking_min_down_payment_pct`
  an organization has set today keeps applying to everyone; only a company with an explicit override
  departs from it.
- **A `$0` hold now consumes inventory.** That is the intent — the seats were always promised, they
  simply were not held — but a departure that used to look available at 19:00 the night before may
  now be full, because the hotel's group is finally counted.

---

## Open

| Question | Smallest change that answers it |
|---|---|
| Should `max_price` also bind case B, where the affiliate collects everything itself and our name never appears? | A per-company `enforce_max_on_self_collected` flag. Enforced uniformly for now (D3) because the collection side is unknown at confirm time — a `$0` hold may settle either way. |
| When the affiliate's balance goes negative (case A), is the margin paid out per corte or per sale? | The running balance already nets it and `payouts` already pays it; the open part is only *cadence*, which is a Settings value, not a schema decision. |
| Does a net-priced line's cancellation retain differently from a rate-priced one? | US-A72 already reserved per-affiliate retention in `cancellation-policy-engine.spec.md`. Until it is built, a net-priced line follows the org ladder like any other. |
