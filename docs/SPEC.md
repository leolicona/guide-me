# Turistear Ya! — Product Specification

## Product Vision

Turistear Ya! is a multi-tenant, mobile-optimized SaaS platform that centralizes the sale of tourist services, real-time inventory control, commission calculation, and access validation via QR codes. It is designed so that tourism companies (organizations) can operate agilely in the field, ensuring financial control and a modern digital experience for the tourist.

**Problem solved:** Tourism sales teams operate with spreadsheets, informal WhatsApp, and untraceable cash. Turistear Ya! replaces this chaos with a mobile-first tool that prevents overbooking, controls commissions, and delivers digital receipts + QR tickets — by Email and **agent-sent WhatsApp** (the portal link), with delivery **tracked to receipt**.

---

## Design Principles

- **Mobile-first:** The entire agent interface is designed for field use on mobile phones, without relying on a desktop.
- **Online QR validation (MVP):** The scanner requires an internet connection (3G/4G/WiFi) to validate and consume tickets in real-time against the server. Offline capabilities will be introduced post-MVP.
- **Authentication via email and password for admins and agents:** Both administrators and sales agents log in using their email and password. Clients do not log in directly in this phase.
- **Email ownership verification:** Account verification for admins (on registration) and agents (on accepting invitations) is done via magic links sent through Resend.
- **Real-time inventory:** No agent can sell more spots than those available at a given time slot.
- **Multitenancy:** Each organization operates in a completely isolated manner (data, catalog, staff).

---

## System Roles

| Role | Description | Authentication |
|---|---|---|
| `admin` | Full control of the organization: catalog, staff, reports, finances | Email + password (verification via Resend magic link) |
| `agent` | Sells services, manages daily cash drawers, scans access QRs | Email + password (onboarding/verification via Resend magic link) |
| `affiliate` | External reseller (hotel, travel agency, restaurant) who resells the operator's services under a **per-affiliate negotiated commission** and sends groups. Behaves like an agent seller but is **not an employee**: sells through a tailored POS limited to **only the services the admin curated for them**, yet has **no access scanner and no expense recording**; sees only **their own** sales and balance. Each affiliate user belongs to one `affiliate_company`. | Email + password (admin-invited, verification via Resend magic link) |
| `client` / `tourist` | Phase 1: receives digital tickets and QR codes via Email, no direct app interaction. Phase 2: self-service booking portal (itinerary, QR download, cancellation request + Refund PIN) | No authentication in Phase 1; passwordless **Magic Link** to the portal in Phase 2 |

---

## User Stories

### Administrator

### Authentication and Account

- **US-A01** — As an admin, I want to register with my name, email, password, and company name to create my organization in Turistear Ya!
- **US-A02** — As an admin, I want to verify my email by clicking on a magic link sent via Resend to activate my account.
- **US-A03** — As an admin, I want to log in with email and password to access my dashboard.
- **US-A04** — As an admin, I want to recover my password via email in case I forget it.

#### Staff Management

- **US-A05** — As an admin, I want to invite a sales agent by email to join my organization.
- **US-A06** — As an admin, I want to see the list of active agents in my organization with their contact info and status. *(Rev. 2026-06-11: agents no longer carry a commission rate — commission is defined per service, US-A12.)*
- **US-A07** — As an admin, I want to edit an agent's profile (name, phone). *(Rev. 2026-06-11: the base commission percentage moved to the service — US-A12.)*
- **US-A08** — As an admin, I want to deactivate (suspend) an agent so they lose access to the platform without deleting their history.

#### Affiliate Management

> Affiliates are **external resellers** (hotels, travel agencies, restaurants) who sell the
> operator's services and send groups, earning a **per-affiliate negotiated commission**. The
> admin registers the partner company, sets its per-service commission, and invites its logins.
> An affiliate behaves like an agent seller **minus** the field capabilities — no access scanner,
> no expense recording. Full spec: `docs/affiliates/affiliate-setup-commissions.spec.md`.

- **US-A48** — As an admin, I want to register an **affiliate company** (name, contact email/phone, status) so I can model the commercial partner before inviting its users. *(Suggested precondition for US-A49; every affiliate user is linked to exactly one affiliate company. Create entry point is the Affiliate Setup Wizard — US-A54.)*
- **US-A49** — As an admin, I want to invite an affiliate by email, **selecting the affiliate company** they belong to, so other businesses can sell my services. The invitation reuses the agent-invite flow (Resend magic link → US-AF01); the invitee is created with the `affiliate` role linked to the chosen `affiliate_company`. *(User-provided story #1; primary entry point is the Wizard's Step 3 — US-A57 — with standalone invites available later.)*
- **US-A50** — As an admin, I want to set **per-affiliate, per-service commissions** — either a **percentage** of the sold price or a **fixed amount per spot** — so each partner has a personalized commission reflecting the volume they bring. Persisted as an `affiliate_commission` row keyed by `(affiliate_company_id, service_id)`; **the row's existence is also the affiliate's allow-list** — a service with no row is **not visible or sellable** by that affiliate (no fallback to the service's standard commission). The rate is a **flat percent or fixed-per-spot per service** — not an automatic volume-tiered escalation. *(User-provided story #2; set in the Wizard's Step 2 — US-A56.)*
- **US-A51** — As an admin, I want every sale **attributed to either an agent or an affiliate company**, so my dashboards, commission reports, and exports separate in-house sales from affiliate sales. Each folio records the seller and, when sold by an affiliate, the `affiliate_company_id`. *(User-provided story #3.)*
- **US-A52** — As an admin, I want to **deactivate (suspend) an affiliate company or one of its users**, so they lose access without deleting their sales history (existing folios and tickets stay intact). *(Suggested; mirrors US-A08.)*
- **US-A53** — As an admin, I want a **commission report and settlement view per affiliate** for a date range — total sales, commission earned, and the **cash the affiliate still owes** (collected − commission − confirmed deposits) — so I can reconcile each partner. The affiliate collects from the tourist and holds the operator's cash, so settlement runs in the **same direction as an agent's** (the affiliate hands in / transfers the net). *(The per-affiliate drill-down of US-A17 — the same report read filtered to one `affiliate_company_id`, reusing the cash-drop confirmation flow.)* — `docs/reports/commission-report.spec.md`

##### Affiliate Setup (Wizard)

> Mirrors the Service Creation Wizard (US-A38–A44): registering an affiliate company runs through a
> single guided **3-step modal** that captures the partner, curates **which services they may sell
> and at what commission**, and fires the user invitations in one pass. There is **no default
> catalog access and no fallback commission** — an affiliate sees only the services the admin
> explicitly enables and prices here. Re-homes US-A48 / A49 / A50. Full spec:
> `docs/affiliates/affiliate-setup-commissions.spec.md`.

- **US-A54** — As an admin, I want to register an affiliate through a step-by-step **Wizard** so I set up the partner, their sellable catalog, and their logins without juggling separate screens. The modal is **full-screen on mobile (90vh) with rounded top edges**, a **fixed header** (title *"Nuevo afiliado"*, close **X**, step indicator *"PASO n DE 3"*), a **progress bar** that fills with the current step, and a **fixed footer** with *Anterior* / *Siguiente* (→ *Finalizar* on the last step); *Anterior* is disabled on Step 1. *(Re-homes the create entry point of US-A48; create-only — edit keeps a standard form.)*
- **US-A55** — As an admin, on **Step 1 — Company Info** I want **Company name** (required) and **contact email / phone** fields, so the partner is identifiable. *Siguiente* is blocked until the company name is valid. *(Refines US-A48.)*
- **US-A56** — As an admin, on **Step 2 — Catalog & Commissions** I want a list of all **active services**, each with an **ON/OFF toggle**; turning a service **ON** reveals an **inline commission input** with a **Percentage (%) / Fixed ($) segmented toggle** (the input symbol updating on switch), and a commission is **required** while the service is enabled. **Only enabled services become sellable** by this affiliate; *Siguiente* is blocked if any enabled service has an empty or zero commission. Each enabled service persists one `affiliate_commission` row keyed by `(affiliate_company_id, service_id)` — its existence **is** the allow-list. *(Refines US-A50; resolves the no-fallback decision — an un-enabled service is invisible in the affiliate POS.)*
- **US-A57** — As an admin, on **Step 3 — Invitations** I want to add one or more affiliate **email addresses** so that, on *Finalizar*, the company + commissions are saved and a Resend magic-link invitation goes to each address (US-AF01). Adding emails is **optional** — I can invite users later. *(Orchestrates US-A49.)*

#### Service Catalog

- **US-A09** — As an admin, I want to create a tour/service (e.g., "Canyon Sunrise Tour") with a name, description, base price, minimum selling price, and maximum capacity per time slot.
- **US-A10** — As an admin, I want to define recurring schedules or specific dates for each service, with its independent capacity per slot.
- **US-A11** — As an admin, I want to add optional "extras" to a service (e.g., "Professional photo", "Travel insurance") with their individual price.
- **US-A12** — As an admin, I want to define each service's commission — either a **percentage** of the sold price or a **fixed amount per spot** — so that any seller (agent or admin) earns exactly that commission for selling it. *(Rev. 2026-06-11: replaces the earlier "base % per agent + bonus per service" model — `docs/commissions/service-based-commission.spec.md`.)*
- **US-A13** — As an admin, I want to edit or deactivate a service in the catalog without affecting already sold tickets (folios). Deactivation is a **soft pause** (`status: 'inactive'`): the service drops out of the POS and affiliate catalogs but **keeps its config and any `affiliate_commissions` rows**, so reactivating it restores everything — including each affiliate's access — exactly as before.
- **US-A58** — As an admin, I want to **permanently delete** a service that I no longer offer, so my catalog stays clean. Deletion is **blocked while the service has any sold/booking folios** (history must stay intact) — the admin is steered to deactivate (US-A13) instead; an unused service is hard-deleted and its `affiliate_commissions` rows are removed with it. *(New; complements the soft-pause of US-A13. Open: exact guard set — see the catalog spec.)*
- **US-A36** — As an admin, I want to define whether a service has a **Hard Cap** (strict) or **Flexible Cap / Soft Cap** capacity and, when flexible, set a tolerance percentage of extra spots, when creating or editing a service — so the POS applies the correct overbooking rule and sellers can secure last-minute revenue without compromising operations. The catalog form includes a capacity-type control; **new services default to Hard Cap**. When Hard Cap is selected the *Allowed Extra Places* field stays hidden/disabled; when Soft Cap is selected an incremental numeric *Allowed Extra Places* field is enabled, accepting **1–30 % of base capacity** (the allowed ceiling is configurable per organization in the Settings panel). The form blocks saving if Soft Cap is selected but the field is empty or `0`, and shows **inline help text explaining the impact**. Persisted on the `services` table as `is_flexible` (boolean) + `flex_capacity_pct` (integer); the POS service-detail/slots endpoint returns both fields so the frontend computes **Effective Capacity** (base capacity + flexible margin) live as the agent adjusts the people counter. **Mutually exclusive with Zoned Capacity (US-A64)** — enabling zones clears Soft Cap, since strict per-zone ceilings make the margin unreachable. — `docs/catalog/flexible-capacity.spec.md`
- **US-A37** — As an admin, I want to assign a **primary category** to each service when creating or editing it (Lodging, Tours, Dining, Adventure, Culture), so the POS automatically organizes the catalog and lets agents filter it with a single tap. The catalog form adds a **required** single-select *Service Category* dropdown drawn from a closed enum; saving with no category selected shows a *"Selecciona una categoría"* error. Persisted on the `services` table as `category`; surfaced on `GET /api/pos/services` so the POS renders a filter chip **only for categories that have at least one available service**. — `docs/catalog/service-categories.spec.md`

##### Accommodation (Lodging — category-specific service type)

> The first **category-specific** service type. A `lodging` service (US-A37 `Hospedaje`) is a
> property/listing that owns **unit types** (Airbnb/OTA model — approved RFC
> `docs/RFCs/rfc-airbnb-inventory-model.md`); each type carries an **inventory count**, its own
> nightly pricing, occupancy, availability controls, and amenities, and is sold as a **quantity of
> rooms for a date range** (multi-night stay) rather than a per-day slot. Nobody picks a physical
> room — Turistear Ya! is a sales POS, not a PMS. This is a new inventory primitive **beside** slots —
> tours are untouched. Full spec: `docs/lodging/accommodation-stays.spec.md`.

- **US-A59** — As an admin, I want to define a **lodging service** and add **unit types** under it (e.g. "Habitación Estándar", "Cabaña Río"), each with an **`inventory_count`** (how many interchangeable rooms of that type exist), **number of beds**, **base occupancy**, and **maximum capacity** per room, so my inventory is modeled as sellable room types — a unique boutique cabin is simply a type with count 1 and gets its **own card in the POS catalog**. Types are children of the `lodging` service (`accommodation_unit_types`), soft-deactivated never hard-deleted (folio history). *(D1/D2/D14 — unit-type inventory, per-type config, flattened catalog.)* — `docs/lodging/accommodation-stays.spec.md`
- **US-A60** — As an admin, I want to set each unit type's **rate rules** — a **base price per night**, an optional **weekend rate**, **seasonal overrides** (named date ranges with their own nightly rate), and a **cost per extra person per night** above the base occupancy — so pricing reflects demand and party size. Per night the engine resolves **seasonal > weekend > base**; weekend days are org-configurable (default Fri+Sat). *(D3 — pricing precedence + extra-person surcharge.)* — `docs/lodging/accommodation-stays.spec.md`
- **US-A61** — As an admin, I want each unit type's **availability controls** — a **quantity block-out calendar** (remove N rooms of the type from inventory for a date range; overlapping block-outs sum), a **minimum stay** (min nights), and **check-in / check-out times** — so I protect maintenance/owner days and enforce my stay rules. Availability uses **standard hotel turnover** (a stay occupies nights `[check-in … check-out)`; the check-out day is reusable same-day). *(D4/D5/D6/D11.)* — `docs/lodging/accommodation-stays.spec.md`
- **US-A62** — As an admin, I want to tag each unit type with **amenities** (WiFi, parking, kitchen, A/C, pool, …) from a closed set, so agents and tourists see what each type offers. Stored as amenity enum keys on the type; labels live on the frontend. *(D6.)* — `docs/lodging/accommodation-stays.spec.md`
- **US-A63** — As an admin, I want a **structured cancellation policy** for stays — **free cancellation until N days before check-in, then an X% penalty** — that ties into the existing folio-cancellation flow, so paid-stay refunds are computed consistently. The policy governs **paid** stays (refund = total, or total − penalty inside the cut-off); a **booking/apartado** stay cancelled keeps the existing **non-refundable-deposit** rule (US-AG07.4). Org-scoped settings (`lodging_free_cancel_days`, `lodging_cancel_penalty_pct`). *(D9.)* — `docs/lodging/accommodation-stays.spec.md`
- **US-A64** — As an admin, I want to **subdivide a slot-based service's capacity into named physical zones** (e.g. a Turibus's *Piso alto* / *Piso bajo*), each with its own seat count, so agents sell a specific zone and no single area is overbooked. It is **opt-in per service** (`services.zones_enabled`); every service stays a single undifferentiated pool until turned on. Zones are a **pure inventory partition** — same price, minimum price, commission and extras — so moving a passenger between zones has no financial consequence and no per-zone pricing exists. The admin defines **2–6** free-text zones (name + seats); enabling **clears Soft Cap** (US-A36) and, on a service with future sales, assigns those seats to a chosen zone. Each departure records its **own** per-zone seat count (`slot_zones.capacity`, snapshotted at creation) so editing a zone later never rewrites past departures; `slots.capacity`/`booked` are reconciled from the zones so every existing read is untouched. The POS shows availability per zone and the agent picks one (a split party = one folio line per zone, one QR each); a zone can be **closed for a single departure** (rain on the upper deck) blocking new sales while sold seats stay valid; the scanner **displays** the zone without enforcing it, so pre-feature QRs remain valid. *(New — mirrors the lodging unit-type inventory shape for slot-based services; no per-zone pricing, no gate enforcement, no per-line cancellation.)* — `docs/catalog/zoned-capacity.spec.md`

##### Guided Service Creation (Wizard)

> Re-homes the split *create-then-configure* catalog flow (today: `POST /services` in a small
> dialog, then extras + schedules added separately on the detail page) into a **single guided
> 4-step modal**, so a field operator builds a complete, sellable service in one pass without
> facing every option at once. No new service fields — it reorganizes and orchestrates the
> existing catalog/slots/extras endpoints (US-A09/A10/A11/A12/A36/A37). Same re-homing pattern
> as the POS Bottom Sheet (US-AG31). Full spec: `docs/catalog/service-wizard.spec.md`.

- **US-A38** — As a field tour operator, I want to create a service through a step-by-step **Wizard** so I'm not overwhelmed by every option at once and make fewer errors. The modal is **full-screen on mobile (90vh) with rounded top edges**, has a **fixed header** (title *"Nuevo servicio"*, close **X**, step indicator *"PASO n DE 4"*), a **progress bar** that fills with the current step, and a **fixed footer** with *Anterior* / *Siguiente* (→ *Guardar* on the last step). *Anterior* is disabled on Step 1. *(Re-homes the create entry point of US-A09; create-only — edit keeps the existing dialog/detail page.)*
- **US-A39** — As an operator, on **Step 1 — Basic Information** I want fields for **Service Name** (short text), **Category** (dropdown — the US-A37 closed enum), and **Description** (text area), so the service is identifiable in the catalog and POS. *Siguiente* is blocked until **Name and Category** are valid. *(Refines US-A09/US-A37.)*
- **US-A40** — As an admin/owner, on **Step 2 — Pricing & Commissions** I want **Base price** and **Minimum price** numeric fields (both open the mobile **numeric keypad**), a validation that **Minimum price may not exceed Base price**, and a **segmented toggle** to pick commission **Percentage (%)** vs **Fixed amount ($)** with the input **symbol updating** ($/%) on switch, so the POS computes seller earnings correctly. *(Refines US-A09/US-A12 — same `commission_type`/`commission_value` and `minimum_price ≤ base_price` rule.)*
- **US-A41** — As an operator, on **Step 3 — Availability** I want **Capacity** (numeric) and **Quota Type** (*Estricto* / *Flexible* — the US-A36 Hard/Soft Cap), a **Frequency** selector (*Fecha única* / *Recurrente*); for *Fecha única* a single calendar day; for *Recurrente* a **quick-select chip carousel** (*Resto del año*, *Resto del mes*, *Fines de semana*) that highlights on tap, an **operating-days** initials toggle (L M M J V S D, multi-select), and **Desde** / **Hasta** dates, so I control inventory precisely and avoid overbooking. *(Refines US-A10/US-A36; the quick-select chips are a new frontend convenience that computes weekdays + date range.)*
- **US-A42** — As an operator, still on **Step 3** I want to add **multiple departure times** for the same service via a **time input + Add** button (*Add* disabled while empty), each added time shown as a removable **pill** (X to delete), with **duplicates rejected**, so I can sell different time slots (e.g. 9 AM and 12 PM). *(Refines US-A10 — each departure time maps to one schedule/slot creation at save.)*
- **US-A43** — As an operator, on **Step 4 — Extras** I want, when none exist, a *"Aún no hay extras"* empty state; an inline **Add Extra** form (**Name** + **Price**) whose *Add* button stays inactive until **both** fields have content; on add the new extra is **prepended** to the list with its **price in green**, the form **inputs clear**, and each extra has a **trash** action to remove it — so I lift my average ticket. *(Refines US-A11.)*
- **US-A44** — As an operator, I want **Step 4's footer button to read *Guardar*** and, on tap, to **compile the 4 steps and persist the service** (core + capacity/commission + availability + extras); on success the Wizard **closes** and a **success notification** appears on the catalog. *(Orchestrates `POST /services` then the schedules/slots and extras creations; see the spec for the atomicity decision.)*

#### Dashboard and Monitoring

- **US-A14** — As an admin, I want to see a visual occupancy dashboard showing the status (available / close to capacity / full) of all active schedules for the day.
- **US-A15** — As an admin, I want to see in real-time how many spots remain available per service and schedule, surfaced both as a count and as the unrealized revenue of the empty seats.
- **US-A16** — As an admin, I want to see a summary of the day's sales: total collected, number of folios, and sales per agent.

#### Financial Reports and Commissions

- **US-A17** — As an admin, I want a **commission & settlement report per seller for a date range** — total sales (split **cash vs electronic**), **commission earned** (service-based, US-A12), cash collected, confirmed cash drops, and payouts, resolving to the **net cash the seller still owes** (or the company owes them) over the period — so I reconcile each agent **and affiliate** against the running-balance model. *(Rev. — replaces the obsolete "base commission + service bonuses, total commission to pay" framing: commission is no longer a separate disbursement but is **kept by the seller via deduction from the cash they owe** (net-remittance); a literal payout happens only when the period balance is negative (electronic-heavy sales), cleared by US-A25. Covers agents and affiliates by seller; US-A53 is the per-affiliate settlement drill-down.)* — `docs/reports/commission-report.spec.md`
- **US-A18** — As an admin, I want a **performance comparison across sellers** (agents and affiliates) for a given period — **folios sold, total amount, cash-vs-electronic split, and commission earned** — ranked so I can see who is selling and reward by evidence. *(Same period query as US-A17, attributed by seller via `folios.agent_id` / `folios.affiliate_company_id`, US-A51.)* — `docs/reports/commission-report.spec.md`
- **US-A19** — As an admin, I want to confirm receipt of the cash that agents hand in (cash drops) and see each agent's current outstanding balance (the company cash they are holding). The dashboard must display a shift-scoped breakdown for each agent (calculating collected, commissions, and expenses strictly since their last confirmed drop, plus a carry-forward line) rather than all-time historical totals, enabling clean daily reconciliations.
- **US-A25** — As an admin, if an agent has a negative balance (the company owes them money), I want to record a "Payout" (Transfer/Payroll) to return their balance to zero.
- **US-A20** — As an admin, I want to **export the period commission & settlement report (CSV or PDF)** — one row per seller with the same columns as US-A17 (sales, cash/electronic split, commission earned, collected, confirmed drops, payouts, net owed) — for payroll, accounting, or partner reconciliation outside the app. *(Export of the US-A17 read; no new data.)* — `docs/reports/commission-report.spec.md`
- **US-A27** — As an admin, I want to directly register a cash collection from an agent (face-to-face) so that their running balance is immediately reduced, without requiring the agent to submit a pending request first.
- **US-A28** — As an admin, when reviewing a pending cash drop from an agent, I want to be able to adjust the received amount before confirming it (adding a mandatory explanatory note), so I can correct discrepancies without having to reject the entire request.
- **US-A29** — As an admin, I want to configure my organization's **acknowledgment window** — the time my agents have to sign or dispute a direct collection (US-A27) or an adjusted drop (US-A28) before it auto-signs (default 24 hours, allowed range 1–168 h) — so the audit cadence matches my operation's settlement rhythm (e.g. a weekend-route agency widens it to 72 h).
- **US-A30** — As an admin, when an agent disputes a direct collection or an adjustment, I want to see the open dispute (with the agent's reason) in my cash queue and close it with a mandatory resolution note, so the audit trail is complete without altering settled amounts (a genuine correction is recorded separately as a payout or a new collection).

#### Cancellations

- **US-A21** — As an admin, I want to cancel an entire folio to automatically release the spots for all included services and record the cancellation.
- **US-A22** — As an admin, I want to partially cancel specific spots/services within a folio, releasing only the corresponding inventory without cancelling the whole group.
- **US-A23** — As an admin, I want to mark a cancelled folio (or partial cancellation) as "refunded" to track if the physical cash has been returned to the client.
- **US-A26** — As an admin, when cancelling a folio, I want to choose if the cancellation triggers a "Clawback" (agent loses commission) or if the company absorbs the loss.
- **US-A24** — As an admin, I want to see an audit timeline on the folio details page showing who created it, when it was cancelled, and by whom, with the associated reason.

#### Vendor Capabilities (Admin as Seller)

> The admin's primary daily activity is selling. These stories make the admin a first-class
> seller — the same POS flow, scanner, and commission math agents use — with one asymmetry that
> reflects their elevated permissions: the admin's own cash settlement is **self-authorized**.
> Full spec: `docs/admin-vendor/admin-vendor-capabilities.spec.md`.

- **US-A31** — As an admin, I want to sell services through the same POS flow agents use (catalog → cart → checkout → folio), so I can serve customers directly without leaving my account.
- **US-A32** — As an admin, I want to validate access by scanning clients' QR codes, so I can grant entry like my agents do.
- **US-A33** — As an admin, I want to earn commission on my own sales under the **same rule** as agents — the commission defined on each service sold (US-A12), snapshotted at POS — so my earnings are tracked consistently and I appear as a seller in the commission report. *(Rev. 2026-06-11: commission is service-based, so this holds by construction — no per-seller rate exists to configure.)*
- **US-A34** — As an admin, I want my own cash hand-ins (and payouts when the company owes me) to be **self-authorized** — born confirmed, never entering an approval queue, with no acknowledgment window — since I hold elevated permissions, while the accounting stays byte-identical to an agent's.
- **US-A35** — As an admin, I want a **"Tu caja"** section on my Caja screen showing my own drawer (cash collected, commission earned, net to hand in) with an *Entregar* action, pinned above my team's balances, so I reconcile my own cash alongside the team's.
- **US-A45** — As an admin selling on `/pos`, I want the **same Date filter** agents use — a **quick-day strip** (`HOY` + the next two days + a calendar button) and a **calendar Bottom Sheet** of square day chips marking the **available days of the month** with month navigation — so I pick the selling day exactly as my agents do, with no admin-specific divergence. *(Satisfied by the shared `/pos` control of US-AG35, via the same-POS-flow guarantee of US-A31.)* — `docs/pos/date-filter-calendar-sheet.spec.md`
- **US-A46** — As an admin, I want to configure the **booking policy** for my organization — the **minimum deposit percentage** (`booking_min_down_payment_pct`, 0–100) and the **hold window** (`booking_hold_days`, ≥ 1) after which an unsettled apartado auto-cancels and releases its spots — so apartados match my business rules. Org-scoped; takes effect for **new** bookings only (existing bookings keep their snapshotted expiry). *(New; feeds the US-AG07.1 resolver — the deposit floor and the auto-expiry sweep.)* — `docs/bookings/bookings-down-payments.spec.md`
- **US-A47** — As an admin, I want **two independent time-of-departure policies** so I can stop selling a slot that has already left while controlling apartado grace separately: a **sales cutoff** (`sales_cutoff_offset_minutes`) that closes **new walk-in sales and booking creation** for a slot once its departure crosses the offset, and a **booking grace** (`booking_grace_offset_minutes`, renamed from `same_day_buffer_minutes`) that decides **when an unsettled same-day apartado auto-cancels**. Both are **signed minutes** — positive = *before* departure, negative = *after* (a grace window); the admin UI uses a positive number + a **Before/After** selector and translates "After" to a negative integer. Enforced server-side at `confirmSale` (and `reactivate`) → **`409 SLOT_CLOSED`**, and applied to the read filters so the catalog, calendar, and **detail bottom-sheet matrix show only still-sellable times**. *(New; fixes selling/booking a departed slot, which also made a same-day apartado expire on creation. The "now" these offsets compare against now resolves in the org's time zone — see **US-A66** (superseding the original single-timezone UTC model).)* — `docs/bookings/bookings-down-payments.spec.md`
- **US-A66** — As an admin, I want to **configure my organization's time zone** so the current time is consistent for **agents, affiliates, and customers**. One org-level **IANA zone** (`timezone`, curated Mexican-zone picker in Settings; default `America/Mexico_City`) becomes the single clock that (a) anchors the catalog **"hoy"** to the org's day (not each device's), (b) resolves the **sales cutoff / same-day booking grace / booking + ticket expiry** at the real wall-clock instant — **closing BUG-007**, where a slot stored `"19:00"` was compared as 19:00 **UTC** — and (c) renders every **audit timestamp** (folio created, payment, cash move, reminder sent) in org-local time regardless of the viewer's device. Stored slot strings stay naive wall-clock (no data migration); only the "now" they compare against changes. The departure-relative offsets (US-A47) are unchanged — they are tz-independent deltas. Additive migration `0046` (`organizations.timezone`). *(New; supersedes the "single-timezone UTC model" note on US-A47.)* — `docs/timezone/spec.md`
- **US-A65** — As an admin, I want to **edit the WhatsApp message templates** my sellers send — a **ticket-delivery** template (tours + lodging) and an **apartado reminder** template — in Settings, with placeholders (`{customer_name} {agent_name} {org_name} {folio_ref} {total} {pending_balance} {portal_link}` + an auto-expanding `{itinerary}`), so the outbound voice matches my brand. The ticket template **must contain `{portal_link}`** — saving is blocked otherwise, since without it the tourist can't reach their QR. I also want the **Pendiente/Enviado/Visto** delivery badge on my **/folios** list + detail so I can oversee undelivered tickets and **re-send on a seller's behalf**. Org-scoped (`wa_ticket_template`, `wa_reminder_template`; null ⇒ the shipped default). *(New; admin-only editing, read-only for sellers.)* — `docs/whatsapp-qr-delivery/spec.md`

---

### Sales Agent

#### Authentication

- **US-AG01** — As an agent, I want to accept my invitation by clicking the link received via email to activate my account, verify my email ownership, and set my password.
- **US-AG02** — As an agent, I want to log in with my email and password to access the app.
- **US-AG18** — As an agent, I want to recover my password via email in case I forget it.

#### Point of Sale

- **US-AG03** — As an agent, I want to view the catalog of available services with their real-time availability (remaining spots per schedule) to choose what to sell.
- **US-AG04** — As an agent, I want to select a service, choose an available schedule, and add the number of people to start a sale.
- **US-AG05** — As an agent, I want to add optional extras to the sales cart (e.g., photo, insurance) to increase the average ticket size.
- **US-AG06** — As an agent, I want to apply a manual discount to a service's price, with the limit locked at the minimum price defined by the admin, to avoid selling below the allowed cost.
- **US-AG07** — As an agent, I want to register a sale as a "booking/down-payment" (apartado) with a partial amount received, to reserve the spots and collect the rest later. On confirm with a deposit the folio is created `status: 'booking'` with `amount_paid = deposit` (`0 < deposit < total`, `≥` the resolved minimum-deposit %, and a **dialable phone required**); the spots are **decremented immediately**; the customer gets an **apartado confirmation** email — **no scannable QR until settled** (the scanner refuses non-`paid` folios). A one-shot **Liquidar saldo** later collects the full balance → `paid`, minting the per-line QR + portal token, sending the full ticket email, and **topping up the commission** (percent on collected, fixed only on `paid`; attributed to the original seller). Commission follows the reserved rule. *(Umbrella story; refines US-AG08 — the confirm splits into create-booking vs settle; the full paid path is unchanged when no deposit is supplied.)* — `docs/bookings/bookings-down-payments.spec.md`
- **US-AG07.1** — As the system, I want a **policy resolver** for the minimum-deposit % and hold window that computes a booking's release timestamp `booking_expires_at = min(createdAt + holdDuration, slotStart − tourBuffer)` (a **same-day buffer** applies for same-day tours), to protect tour capacity. *(This phase: **org-level globals only**; the resolver is shaped `Service-override ?? Org-global` so per-service overrides drop in later.)* — `docs/bookings/bookings-down-payments.spec.md`
- **US-AG07.2** — As an agent, I want an **adaptive, amount-driven checkout** — the amount input **pre-loaded with the total**, the sale type / button label / validity **derived from the entered amount** (`= total` → *Finalizar Pago*; `min ≤ A < total` → *Registrar Reserva*; below min / above total → disabled), plus a **suggested-deposit chip** (= the org minimum %, shown only when > 0) — so I finalize a full payment in one tap or convert to a booking fluidly, with **no toggle**. *(Refines US-AG07's checkout UI; frontend-only.)* — `docs/bookings/bookings-down-payments.spec.md`
- **US-AG07.3** — As an agent / booth operator, I want a **Reservas (Apartados) dashboard** sorted by **expiry urgency** (orange border < 24h), each card showing the **pending balance** and a one-tap **WhatsApp** quick-action that opens a pre-filled reminder and marks the booking **`Reminder Sent`** (persisted flag + refetch; the icon dims), to recover revenue before spots are released. *(Caller-scoped for agents; admins see the whole org. Powered by `GET /api/pos/folios?status=booking` + `POST /api/pos/folios/:id/reminder`.)* — `docs/bookings/bookings-down-payments.spec.md`
- **US-AG07.4** — As a booth agent, I want to **cancel a booking manually** and **release its spots immediately** back to availability, with the collected deposit treated as **non-refundable and retained in my cash drawer**, to free capacity for walk-ins. *(New agent `POST /api/pos/folios/:id/cancel` — booking-only, distinct from the admin refunding cancellation US-A21.)* — `docs/bookings/bookings-down-payments.spec.md`
- **US-AG07.5** — As a booth agent, I want a **late-arrival contingency**: if an expired booking's freed spots are **still available**, a **Reactivar y Liquidar** action re-blocks them and proceeds to settle; if the tour is full, the action is disabled. *(This phase: **reactivation only**; *Reagendar/Transferir saldo* and *Generar Cupón* render disabled — deferred to a later phase. `POST /api/pos/folios/:id/reactivate`.)* — `docs/bookings/bookings-down-payments.spec.md`
- **US-AG25** — As an agent, I want to select the payment method ("Cash" or "Card") at checkout.
- **US-AG08** — As an agent, I want to confirm the sale and generate a unique folio containing all services in the cart.
- **US-AG09** — As an agent, I want the client to automatically receive their purchase receipt, itinerary, and QR code via Email upon confirming the sale.
- **US-AG30** — As an agent, I want the POS catalog to open on a fast, **default-filtered** view — an **Inline Filter Strip** combining categories and a semantic date context, and an **"Ocultar agotados" toggle that is on by default** — and to load a **lightweight** payload, so I find the right product instantly without pulling slot-level data. The catalog endpoint returns a boolean **`has_availability`** per service (**no slot details, no spot count**) evaluated over the **active date range** (e.g., from today to Sunday). The selected date range is held in **global state** and **inherited by the service-detail view**, so the agent keeps their day context across the drill-in. *(Refines US-AG03 / US-AG10: the catalog read drops the Σ-remaining count for a windowed boolean; the per-slot count stays on the detail screen. The UI is specified by **US-AG35**.)* — `docs/pos/default-filtered-catalog.spec.md`
- **US-AG31** — As an agent, I want a panel to **slide up from the bottom of the screen (Bottom Sheet)** when I tap a service in the catalog, so I can configure the sale (people, time, price) **without navigating to a new page**, keeping the rest of the catalog in view. Tapping a card darkens the background (overlay) and slides an animated sheet up carrying the selection interface (People control, reactive time-slot matrix, checkout button). On a successful *Agregar al carrito* the sheet **slides down (closes) automatically** and a floating **Snackbar** ("Agregado al carrito · Ver carrito") returns control of the catalog to me instantly. *(Refines US-AG04: re-homes the existing service-detail selection from a full page into a sheet; the detail read and discount/extras/confirm logic are unchanged. Frontend-only.)* — `docs/pos/fast-sale-bottom-sheet.spec.md`
- **US-AG32** — As an agent, I want to configure the **number of people first**, before choosing the time slot, within the Bottom Sheet, so the system filters in real time and only shows slots where the whole group fits. The quantity component **`[ − 1 + ]`** is the **first** interactive element; as I adjust it the frontend **synchronously filters** the slot array (`slot.remaining + slot.max_extra_seats >= partySize`, i.e. the existing Effective Capacity `effectiveRemaining ≥ partySize`, US-A36), **removing any non-fitting slot from the DOM**. *(Builds on US-AG31 and US-A36; frontend-only, no new field — `max_extra_seats` maps to the service's flexible margin.)* — `docs/pos/fast-sale-bottom-sheet.spec.md`
- **US-AG33** — As an agent, I want the Bottom Sheet to **inherit the date from the catalog** and immediately show me the time slots for **that day and the two subsequent days**, so I can choose a slot with a single tap. On opening the sheet the detailed slots query runs scoped to the **3-day window** `[anchor, anchor+2]` (`anchor = selectedDate ?? today`, mirroring US-AG30's window). The slot list renders as a **matrix of 3 day rows** with **relative labels** (`Hoy`, `Sáb 14`, `Dom 15`), time-slot chips **flex-wrapping** beside each day's label, and a muted **"(Agotado)"** state when a day has no available time slots. *(Refines US-AG31's date inheritance — single-day/unbounded → a 3-day window; keeps the US-AG32 fit filter, applied per day. Frontend-only.)* — `docs/pos/reactive-date-time-matrix.spec.md`
- **US-AG34** — As an agent, I want the interface to **visually warn me** when, by choosing a certain number of people, I am consuming a slot's **extra cushion**, so I can proceed with caution knowing I am using emergency spots. When `partySize > slot.remaining` yet `partySize <= slot.remaining + slot.max_extra_seats` (i.e. `effectiveRemaining`, US-A36), the time-slot chip turns **orange** (warning border/text) and shows **"Usando X cupos extra"** (`X = partySize − slot.remaining`). The warning is **advisory** — the agent can still select the slot and add to the cart **without blockage**. *(Builds on US-AG32/AG33 and US-A36; supersedes the party-independent flex highlight; frontend-only, no new field.)* — `docs/pos/reactive-date-time-matrix.spec.md`
- **US-AG35** — As an agent, I want the `/pos` filter to be an **inline horizontally scrollable strip** containing category chips, a visual divider, **dynamic week-based context pills** (`ESTA SEMANA`, `ESTE FIN`, `SIG. SEMANA` adapting to the day of the week), and a **calendar button** — and, on tapping the calendar, a **Bottom Sheet** with a **month grid of square day chips** that marks the **available days of the month** and supports single-day and **range selection** (for lodging). Picking a day/range sets the shared `selectedDate` (US-AG30) and closes the sheet. *(Refines US-AG30's Date control — replaces the interim 14-pill strip; reuses the US-AG31 Bottom Sheet pattern. Adds one lightweight read; no migration.)* — `docs/pos/date-filter-calendar-sheet.spec.md`

##### Selling Accommodation (Lodging — date-range stays)

> Agents **and affiliates** sell a multi-night stay by choosing a date range and a **quantity of a
> unit type** (US-A59–A63) — never a physical room — through the same cart → folio → checkout flow
> used for tours, with apartado/deposit support. Full spec: `docs/lodging/accommodation-stays.spec.md`.

- **US-AG36** — As an agent/affiliate, I want to sell a stay **range-first**: I pick a **check-in and check-out date**, the number of **guests**, and a **room quantity**, and the POS shows me **only the unit types with enough per-night inventory for the whole range** with the **computed total** (rooms × nights × nightly rate, including weekend/seasonal rates and the extra-person surcharge over an even guest split), so a tourist can stay more than one day. Powered by `GET /api/pos/lodging/:serviceId/availability?check_in=&check_out=&guests=&quantity=`; types that fail min-stay, capacity (`guests ≤ max_capacity × quantity`), or per-night remaining are hidden. Adding a type puts a **stay line** (`quantity` rooms) in the cart. *(D7/D8/D12 — reuses the cart/folio flow.)* — `docs/lodging/accommodation-stays.spec.md`
- **US-AG37** — As an agent/affiliate, I want to also sell a stay **type-first**: unit types appear as **their own cards in the flattened POS catalog** (exact nightly rate, "Quedan N" low-inventory badge); I open one, see its month **remaining-count calendar** (rooms free per day at that day's rate), and select the range on it, so I can satisfy a tourist who wants a particular cabin or room class. Powered by `GET /api/pos/lodging/unit-types/:typeId/calendar?from=&to=`. *(D8/D14 — both entry points, flattened catalog.)* — `docs/lodging/accommodation-stays.spec.md`
- **US-AG38** — As an agent/affiliate, I want a stay to **check out like any other sale** — the line shows type × quantity · `Sáb 10 → Mar 13 · 3 noches` · guests · total (with a per-night breakdown), and the **adaptive amount-driven checkout** (US-AG07.2) lets me take **full payment or a deposit (apartado)**, holding the rooms for the dates immediately. On confirm the server re-quotes and snapshots the price and inserts the reservation under a **per-night atomic count guard** — ∀ night: `reserved + blocked + requested ≤ inventory_count` — so a concurrent oversell gets `409 INSUFFICIENT_INVENTORY`; cancel/expiry/reactivate release or re-claim the quantity under the same guard. Commission follows US-A12 (percent on the stay amount; **fixed counts per room-stay** = value × quantity). *(D7/D9/D10/D13; builds on US-AG07/AG07.2/AG07.4/AG07.5 and US-AG11.)* — `docs/lodging/accommodation-stays.spec.md`

#### Ticket Delivery (WhatsApp)

> Once payment is complete, the agent delivers the tickets over WhatsApp — a preconfigured message
> carrying the **portal link** (itinerary + QR + cancellation). WhatsApp is the primary channel;
> email becomes an optional copy. The loop is closed by a receipt signal (US-T06). Full spec:
> `docs/whatsapp-qr-delivery/spec.md`.

- **US-AG39** — As an agent/affiliate, once a sale is paid I want a prominent **"Enviar boletos por WhatsApp"** action on the receipt (and on my folio detail, to re-send) that opens **my own WhatsApp** with the customer's number and a **preconfigured message** carrying the **portal link** (itinerary + QR + cancellation), so I hand the tourist their tickets in one tap. `wa.me` is text-only, so the link — not an attached image — is the payload; the phone is normalized to an international number (default +52). *(Generalizes the US-AG07.3 WhatsApp deep-link; the portal link is now exposed to the client on confirm + folio detail. Fulfils the WhatsApp half of the deferred US-AG22 re-send.)* — `docs/whatsapp-qr-delivery/spec.md`
- **US-AG40** — As an agent/affiliate (and admin), I want each paid folio to show a **delivery status — Pendiente de enviar → Enviado → Visto** — on the receipt, my history list/detail, and the admin folios list/detail, so I can see at a glance which tickets still need sending and which the customer has actually opened. **Enviado** is set when I tap send (my accountability — I can't force a customer to open); **Visto** is set when the tourist **opens their portal**, captured by a bot-proof client-side beacon so link-preview crawlers can't forge it. It is **"Visto"**, never "Validado" (that word means QR-scanned at access). A customer with no WhatsApp simply stays *Pendiente*. *(Delivery axis is separate from payment status, like the US-AG07.3 reminder flag.)* — `docs/whatsapp-qr-delivery/spec.md`

#### Real-Time Availability

- **US-AG10** — As an agent, I want to see a clear indication of how many spots remain per service/schedule on the sales screen to avoid selling full services.
- **US-AG11** — As an agent, I want the system to block my sale confirmation if the spot is no longer available at the time of confirmation (protection against race conditions).

#### Agent Cash Balance (Continuous "Bolsa" / Cash Drops)

> **Model:** instead of a forced daily closure, each agent carries a **perpetual running
> balance** — the company cash they are currently holding. It rises with every collected
> sale and falls with every expense and every **cash drop** (hand-in). Settlement happens
> whenever physical cash moves, not on a clock. This **replaces** the earlier daily
> cash-closure (*corte de caja*) model.

- **US-AG12** — As an agent, I want to see my actual running balance (the exact physical cash I am holding), but with the detailed breakdown (cash collected, commissions, expenses) calculated only since my last confirmed cash drop, including a "carry-forward" line if my previous drop didn't bring my balance to zero, so my daily view is focused on my current shift.
- **US-AG13** — As an agent, I want to register operating expenses (e.g., gasoline, supplies) with amount and description so my running balance is accurate.
- **US-AG23** — As an agent, I want the system to calculate my commission per sale and automatically deduct it from my "Debt to Company" (Running Balance), so I keep my earnings immediately.
- **US-AG24** — As an agent, when I register a sale with a "Card" payment method, I want my commission to be credited to my balance without increasing my cash debt.
- **US-AG14** — As an agent, I want to register a cash drop (hand-in / *entrega de efectivo*) of a given amount to the admin, which reduces my running balance, so settlement happens whenever I hand over cash — no daily closure required.
- **US-AG26** — As an agent, I want a daily snapshot of my own performance (today's sales and amount collected) alongside my running balance and a quick action to register a cash drop, so I can track my day and settle cash without leaving the home screen.
- **US-AG27** — As an agent, I want to receive a notification when the admin registers a direct cash collection from me, so I can review the amount and click "Sign/Acknowledge" to digitally agree — or raise a dispute with a reason if I disagree. If I do neither within my organization's acknowledgment window (24 h by default, configurable — US-A29), the system should auto-sign it to not block the workflow; an open dispute is never auto-signed.
- **US-AG28** — As an agent, if the admin confirms my pending cash drop with an adjusted amount, I want to receive a notification to review the discrepancy and click "Sign/Acknowledge" — or dispute it with a reason. If I do neither within my organization's acknowledgment window (24 h by default, configurable — US-A29), the system should auto-sign it to close the audit trail; an open dispute is never auto-signed.
- **US-AG29** — As an agent, I want my balance dashboard to visually separate my Total Sales (cash vs. electronic), my Earned Commissions, and my Physical Cash Box, so I can easily understand how electronic payments (card, wire transfer, link) benefit me without confusing my physical cash-in-hand debt.

#### Access Scanner (QR)

- **US-AG15** — As an agent, I want to use my phone's camera to scan a client's QR code and validate their ticket in real-time against the server, decrementing one pass from the total spots purchased on that ticket.
- **US-AG16** — As an agent, I want the QR validation to work offline, marking the ticket as consumed on my device and syncing when connection is restored. *(Phase 2)*
- **US-AG17** — As an agent, I want to see a clear scan result screen: ✓ Valid (client name, service, schedule, and redemption progress e.g., "Pass 2 of 5 used") or ✗ Invalid (reason: all passes used, expired, fake).
- **US-AG19** — As an agent, I want to see a clear error message if I try to scan a QR code without internet connection, indicating that the validation requires network access.

#### Folio History

- **US-AG20** — As an agent, I want to see a list of my historical sales (folios) with their status (paid, booking, cancelled) so I can review my past transactions.
- **US-AG21** — As an agent, I want to view the details of a specific folio I created, including the services sold and amounts, to answer customer queries.
- **US-AG22** — As an agent, I want to be able to resend the purchase receipt and QR code via email to a customer from my folio history if they lost it. *(Deferred to Phase 2)*

---

### Affiliate (External Reseller)

> A reseller surface for external partners (hotels, travel agencies, restaurants) who sell the
> operator's services and send groups. **Admin-invited** `affiliate` users transact on a tailored
> POS and earn a **per-affiliate negotiated commission** (US-A50). The role mirrors the Sales Agent
> **minus the field capabilities**: an affiliate **cannot scan / validate QRs** (US-AG15) and
> **cannot record expenses** (US-AG13), since they are not employees in the field. They see only
> **their own** sales and balance (cross-affiliate / cross-org → `404`). Full spec:
> `docs/affiliates/affiliate-portal.spec.md`.

- **US-AF01** — As an affiliate, I want to accept my email invitation to create an account — verifying my email, setting my password, and entering my **company name (required)** and **position (optional)** — so my partner profile is complete. *(User-provided story #4; parallels US-AG01.)*
- **US-AF02** — As an affiliate, I want to log in with my email and password to access my reseller portal. *(Parallels US-AG02.)*
- **US-AF03** — As an affiliate, I want to recover my password via email if I forget it. *(Parallels US-AG18.)*
- **US-AF04** — As an affiliate, I want to land on my **own POS** (not the agent/admin shell) showing **only the curated services the admin enabled for my company** (US-A56) — never the full catalog — and sell them through the same catalog → cart → checkout → folio flow agents use, collecting **full payment at the time of sale** so the customer's QR is generated immediately. I see this curated catalog-with-availability, a checkout, my balance, and a deliver-cash action — but **no access scanner and no expense recording**. *(Parallels US-AG03–US-AG08, scoped down; catalog filtered to the affiliate's `affiliate_commissions` allow-list.)*
- **US-AF05** — As an affiliate, I want to register a sale as a **booking / down-payment (apartado)** — reserving the spots with a partial payment and collecting the balance later — exactly as an agent does. *(Reuses the bookings flow US-AG07 / US-AG07.1–.5; QR is minted on settlement, per that flow.)*
- **US-AF06** — As an affiliate, I want to apply a **manual discount** to a service's price down to the admin-defined **minimum price** (never below), just like an agent, so I can close the group. *(Parallels US-AG06; percent commission then computes on the discounted line total, US-A50.)*
- **US-AF07** — As an affiliate, I want the tickets, itinerary, and QR codes delivered by email on sale (to me for group distribution and/or the customer), so my group can board. *(Reuses US-AG09 / US-C01–C02 email delivery.)*
- **US-AF08** — As an affiliate, I want to carry a **running balance** of the operator's cash I'm holding (Σ collected − Σ my commission − Σ deposits) and to **register a deposit / transfer (cash drop)** that reduces it once the admin confirms receipt, so I settle exactly like an agent — **but with no expenses** to deduct. *(Reuses the agent running-balance + cash-drop model US-AG12 / US-AG14 / US-AG23, minus US-AG13 expenses.)*
- **US-AF09** — As an affiliate, I want to see my **own sales history** (folios) with status and details, so I can review what I sold and answer my customers' queries. *(Parallels US-AG20 / US-AG21, caller-scoped to the affiliate.)*

---

### Platform & Localization

- **US-L01** — As a user (admin or agent), I want the app to display in Spanish (MX) by default, since it is the primary market language.
- **US-L02** — As a user (admin or agent), I want to switch the app language between Spanish (MX) and English so I can use the interface in my preferred language.
- **US-L03** — As a user (admin or agent), I want my language preference to be persisted in the browser so the app loads in my chosen language on every visit without needing to change it again.

#### Navigation & App Shell (UX)

> Reorganizes the authenticated shell around each role's daily loop. Full spec:
> `docs/navigation/app-shell-redesign.spec.md` (rationale: `docs/navigation/role-based-ia-reorganization.md`).

- **US-UX01** — As a user, I want to land directly on my first daily action when I open the app (agent → **Vender**, admin → **Hoy**), instead of a placeholder dashboard, so I save a tap every session.
- **US-UX02** — As a user, I want navigation destinations named by **concept** and shared across roles (**Vender · Escáner · Ventas · Caja · Hoy**), so the same label always means the same thing and an admin can train an agent by pointing at the same buttons.
- **US-UX03** — As a user, I want the top app bar removed so content uses the full viewport, with my identity and **Cerrar sesión** living in an account surface — a bottom-pinned avatar popover on desktop, a fixed top-right avatar chip + bottom sheet on mobile.
- **US-UX04** — As an admin, I want occasional management tools (Agentes, Catálogo, Configuración, Reportes) in the account/overflow menu rather than the daily nav bar, so my daily destinations stay focused.
- **US-UX05** — As a user, I want one consistent verb per action across every screen and dialog (**Cobrar · Entregar · Confirmar · Firmar/Disputar · Cancelar folio**), so the same action never reads two different ways.
- **US-UX06** — As an admin, I want a pending-drops badge on **Caja**, so cash awaiting my confirmation is visible from the nav without opening the screen.

---

### Client

> In this phase, the client does not interact directly with the app. Their experience is 100% via Email.

- **US-C01** — As a client, I want to automatically receive a purchase receipt via Email with details of my service, schedule, and amount paid at the time of sale.
- **US-C02** — As a client, I want to receive a unique QR code for each purchased service to present as an access ticket.
- **US-C03** — As a client, I want to receive an Email notification if my folio is cancelled to know that my booking is no longer active.

---

### Tourist (Self-Service Portal — Phase 2, B2C)

> A post-MVP B2C surface. The tourist accesses a tokenized portal via a **Magic Link**
> emailed at purchase — no account, no password. It **depends on** the Email feature
> (US-AG09 / US-C01) for delivery, and its cancellation flow **extends** Total Folio
> Cancellation (US-A21) and Cash refund tracking (US-A23): US-T04 creates a cancellation
> **request** an admin reviews (funnelling into the existing `cancelFolio`), and US-T05's
> **Refund PIN** closes the physical-cash-returned loop.

- **US-T01** — As a tourist, I want to receive a Magic Link via email upon purchase to securely access my booking portal without creating an account or password.
- **US-T02** — As a tourist, I want to see my full itinerary (services, dates, meeting points) in the portal so I know exactly what I bought.
- **US-T03** — As a tourist, I want to view and download my digital QR tickets from the portal to present them at the access control.
- **US-T04** — As a tourist, I want to initiate a cancellation request directly from the portal so the agency is notified automatically without me having to make a phone call.
- **US-T05** — As a tourist, when my cancellation is approved, I want to see my secure "Refund PIN" in the portal, which I must give to the agent/admin to confirm I received my physical cash back.
- **US-T06** — As a tourist, when I open my portal link I want to see my reservation immediately — and, transparently to me, my opening it **confirms receipt** to the agency (the folio flips to **"Visto"** on their dashboard), so the agent knows their WhatsApp/email reached me without having to chase me. The signal is captured by a client-side beacon that only a real browser fires — link-preview bots that fetch the link never trigger it. *(New; the receipt-confirmation half of the WhatsApp delivery loop — no tourist action required.)* — `docs/whatsapp-qr-delivery/spec.md`

---

## Features by Phase

### Phase 1 — MVP (Initial Scope)

#### 🟢 MUST HAVE
*Critical features required to launch the MVP.*
- [x] **Auth (admin & agent via email/password, verification via Resend)** *(US-A01, US-A02, US-A03, US-A04, US-AG01, US-AG02, US-AG18)*
- [x] **Multitenancy (isolated organizations)** *(Global)* — `docs/multitenancy/multitenancy.spec.md`
- [x] **Staff management (invite via email, edit, deactivate agents)** *(US-A05, US-A06, US-A07, US-A08)* — `docs/staff/staff-management.spec.md`
- [x] **Service catalog with extras and minimum price** *(US-A09, US-A11, US-A13)* — `docs/catalog/service-catalog.spec.md`
- [x] **Schedules/slots with capacity by date and time** *(US-A10)* — `docs/schedules/schedules-slots.spec.md`
- [x] **Mobile point of sale with controlled discount** *(US-AG03, US-AG04, US-AG05, US-AG06, US-AG08)* — `docs/pos/pos-controlled-discount.spec.md`
- [x] **Folio generation with signed QR code (HMAC)** *(US-AG08, US-C02)* — `docs/qr/folio-qr-signing.spec.md`
- [x] **Online QR Scanner** *(US-AG15, US-AG17, US-AG19)* — `docs/scanner/online-qr-scanner.spec.md`
- [x] **Commissions: defined per service (percent or fixed per spot)** *(US-A12)* — `docs/commissions/service-based-commission.spec.md` — *each service carries its `commission_type` + `commission_value`, set in the catalog form; the per-sale commission is computed and snapshotted at POS (Σ per-line: % of line total, or fixed × quantity) and deducted from the running balance. Any seller — agent or admin — earns the same for the same sale. Supersedes the original per-agent base % + bonus model (`docs/commissions/commissions.spec.md`).*
- [x] **Agent continuous cash balance (Net-remittance) with cash drops** *(US-AG12, US-AG13, US-AG14, US-AG23, US-AG24, US-AG25, US-A19, US-A25, US-A26)* — `docs/cash-drops/agent-balance-cash-drops.spec.md`
- [x] **Total folio cancellation** *(US-A21)* — `docs/cancellation/total-folio-cancellation.spec.md`

#### 🟡 SHOULD HAVE
*Important features that add great value, but the system could operate manually without them in the very first days.*
- [ ] **Bilingual UI — Spanish (MX) / English with language switcher** *(US-L01, US-L02, US-L03)* — `docs/i18n/i18n.spec.md`
- [x] **Bookings/down-payments (partial payment with spot reservation)** *(US-AG07, US-AG07.1–.5, US-A46)* - *An agent registers a sale as an apartado via an **adaptive, amount-driven checkout** (input pre-loaded to total; type/button/validity derived from the amount; suggested-deposit chip = the org minimum %): the folio is created `status:'booking'` with `amount_paid = deposit` (≥ the resolved minimum %, dialable phone required), spots reserved immediately, only an apartado email — no scannable QR until settled. A one-shot **Liquidar saldo** collects the balance → `paid`, minting the QR + ticket email and topping up commission (percent on collected, fixed only on `paid`). A **Reservas dashboard** sorted by expiry urgency offers one-tap **WhatsApp** recovery with a persisted reminder flag. **Manual cancel** releases spots with a **non-refundable retained deposit**; the repo's first **scheduled Worker** auto-expires unsettled bookings; **reactivation** re-blocks freed spots when capacity allows. The org sets min-% / hold-days / same-day-buffer; the resolver is cascade-ready. **Deferred:** per-service policy overrides, B2B unpaid scanning, reschedule + coupon. Additive migration.* — `docs/bookings/bookings-down-payments.spec.md`
- [x] **Sending receipt and QR code to client via Email (Resend)** *(US-AG09, US-C01, US-C03)* — `docs/email/client-ticket-delivery.spec.md`
- [ ] **Occupancy visual dashboard (admin)** *(US-A14, US-A15, US-A16, US-AG26)* — `docs/dashboard/occupancy-dashboard.spec.md` (scoped as the broader **Daily Operations Dashboard**; US-AG26 adds the agent's own daily snapshot)
- [x] **Commission report by period** *(US-A17, US-A18, US-A20)* — *A read-only date-range report **per seller** (agent + affiliate) over folios + cash events: total sales (cash vs electronic), **service-based commission earned**, cash collected, confirmed drops, and payouts, resolving to the **net cash owed** — reconciliation under the net-remittance model, **not** a separate "commission to pay". Includes the cross-seller performance comparison (US-A18) and CSV/PDF export (US-A20). US-A53 is the per-affiliate settlement drill-down.* — `docs/reports/commission-report.spec.md`
- [x] **Agent folio history (read-only list and details)** *(US-AG20, US-AG21)* — `docs/folio-history/agent-folio-history.spec.md`

### Out of MVP (Phase 2+)

#### 🚀 PHASE 2: Core Enhancements
- [x] **Advanced Cash Collection (Admin-Initiated & Adjustments)** *(US-A27, US-A28, US-A29, US-A30, US-AG27, US-AG28)* - *Enables face-to-face direct collections and adjustments with a non-blocking sign-or-dispute acknowledgment workflow for agents, auto-signing after a per-org configurable window.* — `docs/cash-drops/advanced-cash-collection.spec.md`
- [x] **Agent Balance UX Overhaul (Cash vs Electronic)** *(US-AG29)* - *Redesigns the agent dashboard to visually separate total sales, earned commissions, and physical cash debt, clarifying the impact of non-cash payments.* — `docs/cash-drops/agent-balance-ux-overhaul.spec.md`
- [x] **Flexible Capacity & Overbooking Tolerance (Hard/Soft Cap)** *(US-A36)* - *Per-service Hard Cap (default) vs Soft Cap with a configurable tolerance %; the POS computes **Effective Capacity** (base + flex margin) live as the agent changes the people counter. Adds `is_flexible` + `flex_capacity_pct` to `services` and surfaces them in the POS service/slots payload; the org-level tolerance ceiling lives in the Settings panel.* — `docs/catalog/flexible-capacity.spec.md`
- [x] **Guided Service Creation Wizard** *(US-A38, US-A39, US-A40, US-A41, US-A42, US-A43, US-A44)* - *Re-homes the split create-then-configure catalog flow into one full-screen, 4-step modal (Basic info → Pricing & commission → Availability & departure times → Extras → Guardar). Frontend-only by default: orchestrates the existing `POST /services`, `/schedules`, `/slots`, and `/extras` endpoints; no new service field, no migration. Adds quick-select date presets and a multi-time departure builder. Create-only; edit keeps the current dialog/detail page.* — `docs/catalog/service-wizard.spec.md`
- [x] **Service Categories & POS Filtering** *(US-A37)* - *Required primary category per service (closed enum: Lodging, Tours, Dining, Adventure, Culture) set on the catalog form. Adds `category` to `services` and exposes it on the POS catalog payload; the POS renders single-tap filter chips, showing a chip only for categories that have at least one available service.* — `docs/catalog/service-categories.spec.md`
- [x] **Default-Filtered POS Catalog & Lightweight Availability Query** *(US-AG30)* - *The /pos catalog opens with a Date filter (default "Hoy"), the category chips (US-A37), and an "Ocultar agotados" toggle (on by default), and loads a lightweight payload: a boolean `has_availability` per service (no slot details, no spot count), evaluated over a rolling 3-day window or the single selected date. The selected date is saved in global state and inherited by the service-detail view. Refines the US-AG03 catalog read.* — `docs/pos/default-filtered-catalog.spec.md`
- [x] **Fast Sale via Bottom Sheet & People-First Reactive Slot Matrix** *(US-AG31, US-AG32)* - *Tapping a catalog card opens an animated bottom sheet (overlay + slide-up) carrying the selection interface — without leaving the catalog; a successful "Agregar al carrito" auto-closes the sheet and fires a floating "Ver carrito" Snackbar. Inside the sheet the People control `[ − 1 + ]` comes first and reactively filters the slot matrix (`effectiveRemaining ≥ partySize`, US-A36), hiding non-fitting slots from the DOM. Frontend-only: re-homes & re-orders the existing service-detail selection; no API or migration; inherits the US-AG30 date context.* — `docs/pos/fast-sale-bottom-sheet.spec.md`
- [x] **Reactive Date & Time Matrix + Flexible-Capacity Visual Warning** *(US-AG33, US-AG34)* - *The Bottom Sheet inherits the catalog date and scopes its slot read to a 3-day window `[anchor, anchor+2]`, rendering a matrix of 3 day rows with relative labels (Hoy / weekday), flex-wrapping time chips, and a muted "(Agotado)" state per sold-out day. A slot chip turns orange with "Usando X cupos extra" when the chosen party dips into the slot's overbooking cushion (`partySize > remaining ≤ effectiveRemaining`), non-blocking. Frontend-only: refines US-AG31's date inheritance and supersedes the party-independent flex highlight; no API or migration.* — `docs/pos/reactive-date-time-matrix.spec.md`
- [x] **Affiliate Setup & Commissions (admin: wizard, curated catalog, per-affiliate rates)** *(US-A48–US-A57)* - *Admin-side foundation for the affiliate program. A **3-step Affiliate Setup Wizard** (US-A54–A57) registers an `affiliate_company`, curates **which active services the partner may sell** and sets each one's **required** commission (flat percent or fixed-per-spot), then invites `affiliate` logins (Resend magic link). Enabling a service **is** the affiliate's allow-list (an `affiliate_commissions` row) — **no default catalog access, no fallback commission**. Adds suspend (US-A52) and a per-affiliate commission/settlement report (US-A53), and stamps every folio with a nullable `affiliate_company_id` for agent-vs-affiliate attribution (US-A51). Additive migration: `affiliate_companies` + `affiliate_commissions` tables, the `affiliate` role, `folios.affiliate_company_id`. **Prerequisite for the Affiliate Reseller Portal.*** — `docs/affiliates/affiliate-setup-commissions.spec.md`
- [x] **Affiliate Reseller Portal (external partners sell on a curated POS)** *(US-AF01–US-AF09)* - *The affiliate-facing runtime. Admin-invited `affiliate` users accept a magic-link invite (US-AF01), then sell on a **tailored POS limited to their curated services** (US-A56): full payment at sale mints the QR, with **manual discounts down to the minimum price** and **bookings/apartados**, just like agents — but **no access scanner and no expense recording**. They collect cash, carry a **running balance**, and settle by **deposit/transfer (cash drop)**, reusing the agent balance model minus expenses; tickets/QRs are emailed (US-AF07) and they review their own folio history (US-AF09). **Builds on Affiliate Setup & Commissions.*** — `docs/affiliates/affiliate-portal.spec.md`
- [x] **POS Date Filter — Quick-Day Strip + Calendar Bottom Sheet** *(US-AG35, US-A45)* - *Replaces US-AG30's interim Date control with a quick-day strip (`HOY` + the next two days + a calendar button) and a calendar Bottom Sheet of square day chips that marks the available days of the month (with month navigation), shared identically by agent and admin-seller. The catalog still defaults to today; picking a day sets the shared `selectedDate`. Adds one lightweight org-scoped read `GET /api/pos/availability/days` (the dates with a sellable slot); no migration.* — `docs/pos/date-filter-calendar-sheet.spec.md`
- [x] **Accommodation / Lodging v1 (named units, date-range stays, per-night pricing)** *(US-A59–US-A63, US-AG36, US-AG37, US-AG38)* - *The first category-specific service type, as originally shipped: a `lodging` service owned named, individually-bookable units, each with per-night rate rules (base + weekend + seasonal overrides + extra-person surcharge), availability controls (block-out calendar, min-stay, check-in/out times, standard hotel turnover), amenities, and a structured cancellation policy, sold range-first or unit-first under an atomic overlap guard (`409 UNIT_UNAVAILABLE`). Additive migrations 0035–0041. **Superseded by the Unit-Type Inventory transition below** — the stories now read per the v2 model.* — `docs/lodging/accommodation-stays.spec.md`
- [ ] **Unit-Type Inventory transition (Airbnb/OTA model)** *(US-A59–US-A63, US-AG36–AG38 — v2)* - *Approved RFC (`docs/RFCs/rfc-airbnb-inventory-model.md`, 2026-07-07): physical units become **unit types with an `inventory_count`**; agents sell a **quantity of a type** for a range, never a physical room (Turistear Ya! is a POS, not a PMS). Flattened POS catalog (one card per type, `item_type` discriminator, "Quedan N" badge), **per-night atomic count guard** (`409 INSUFFICIENT_INVENTORY`; replaces `UNIT_UNAVAILABLE`), type-level **quantity block-outs**, total-guests even-split pricing, fixed commission × quantity, real lodging availability dots (retires the `lodgingInScope` hack). Migration `0042` (rename + additive; test data wiped).* — `docs/lodging/accommodation-stays.spec.md`
- [ ] **Zoned Capacity (physical zones inside a departure)** *(US-A64)* - *Opt-in per slot-based service (`services.zones_enabled`): subdivide a departure's seats into **2–6 named zones** (e.g. Turibus *Piso alto* / *Piso bajo*), each with its own count, so agents sell a specific zone and no area is overbooked. **Pure inventory partition** — same price/commission/extras, no per-zone pricing. Two new tables (`service_zones`, `slot_zones` with a **snapshotted per-departure `capacity`** created eagerly for future slots); `slots.capacity`/`booked` reconciled from the zones so every existing read is untouched; the same **single-statement atomic guard** enforces per-zone (`409 ZONE_UNAVAILABLE`). Split party = one folio line per zone (one QR each); a zone is closable for one departure; the scanner **displays** the zone without enforcing it (pre-feature QRs stay valid). Mutually exclusive with Soft Cap (US-A36). Additive migration `0043`; **no technical debt** (snapshot model, no deferred limitation).* — `docs/catalog/zoned-capacity.spec.md`, `docs/catalog/zoned-capacity.implementation-plan.md`
- [ ] **Offline-capable QR validation with post-sync** *(US-AG16)* - *Deferred from MVP to focus on real-time validation.*
- [ ] **Partial cancellations (per service within the folio)** *(US-A22)* - *Deferred to simplify inventory logic in MVP.*
- [x] **Cash refund tracking** *(US-A23)* - *To ensure the admin can reconcile physical cash returns. Pairs with the Tourist Portal's Refund PIN (US-T05) to confirm the customer received the cash.* — **delivered with** `docs/tourist-portal/tourist-self-service-portal.spec.md` (the request→approve→PIN→confirm loop ships as one feature).
- [ ] **Folio audit timeline** *(US-A24)* - *To track the lifecycle of a sale and resolve internal disputes.*
- [x] **Tourist Self-Service Portal (Magic Link, itinerary, QR, cancellation request + Refund PIN)** *(US-T01, US-T02, US-T03, US-T04, US-T05)* - *B2C portal. Depends on the Email feature (US-AG09/US-C01) for the Magic Link; the cancellation-request + Refund-PIN flow extends Total Folio Cancellation (US-A21) and Cash refund tracking (US-A23).* — `docs/tourist-portal/tourist-self-service-portal.spec.md` (bundles US-A23 refund tracking).
- [ ] **WhatsApp QR Ticket Delivery (agent-sent portal link · Pendiente→Enviado→Visto · templates)** *(US-AG39, US-AG40, US-T06, US-A65; refines Customer Contact — name+phone required, email optional)* - *Agents deliver tickets over WhatsApp: one tap opens their own WhatsApp with the customer's number + a preconfigured message carrying the **portal link** (itinerary + QR). A folio runs a delivery axis **Pendiente → Enviado → Visto** — "Visto" set when the tourist opens their portal via a **bot-proof client-JS beacon** (link-preview crawlers can't forge it). **Name + phone become required at checkout, email optional** (WhatsApp is the primary channel); affiliate delivery is customer-direct (drops the affiliate own-email copy). Admin edits two message templates in Settings (`{portal_link}` enforced; auto-expanding `{itinerary}`). Migrations `0044` (folio `tickets_sent_at`/`_by`/`tickets_viewed_at`) + `0045` (org `wa_ticket_template`/`wa_reminder_template`); new `POST /pos/folios/:id/ticket-delivery`, `/folios/:id/ticket-delivery`, `/portal/:token/seen` (the Visto beacon). Implemented on `feat/whatsapp-delivery-phase1` (PR #8); box unchecked until merged.* — `docs/whatsapp-qr-delivery/spec.md`
- [ ] **Organization Time Zone (one org-local clock: catalog day · cutoff/expiry math · audit-timestamp display)** *(US-A66)* - *One admin-set **IANA time zone** (`organizations.timezone`, curated Mexican-zone picker; default `America/Mexico_City`) becomes the single clock for **agents, affiliates, and customers**. It anchors the catalog **"hoy"** to the org's day, resolves the **sales cutoff / same-day booking grace / booking + ticket expiry** at the real wall-clock instant — **closing BUG-007** (a `"19:00"` slot was compared as 19:00 UTC) — and renders every **audit timestamp** in org-local time regardless of the viewer's device. Stored slot strings stay naive wall-clock (**no data migration**); the departure-relative offsets (US-A47) are unchanged tz-independent deltas. New `api-turistear/src/utils/tz.ts` (`orgToday`/`naiveEpoch`/`orgWallClockMinute`, Intl-backed, DST-correct incl. the Tijuana border) + client `useOrgDateFormatter`/`todayStr(tz)`. Additive migration `0046`. Implemented on `feat/organization-timezone`; box unchecked until merged.* — `docs/timezone/spec.md`

#### 🧭 REORG: Role-Aligned IA & Admin Selling

> Realigns the app to each role's actual workflow (admin = total control **and** a daily
> seller; agent = sell, scan, settle). Plan: `docs/navigation/role-based-ia-reorganization.md`.
> Listed by priority within the reorg initiative.

**🟢 MUST HAVE** *(Reorg Phase 1 — unlock & reorganize; small, immediate value)*
- [x] **Administrator Vendor Capabilities** *(US-A31, US-A32, US-A33, US-A34, US-A35)* — *Unlocks the admin as a first-class seller (POS, scanner, commission under the same seller-independent rule) with self-authorized own-cash settlement; adds the "Tu caja" block (own drawer + sales/commission cards). Financially inert.* — `docs/admin-vendor/admin-vendor-capabilities.spec.md`
- [x] **App Shell Redesign (role-aligned nav, shared vocabulary, account surface)** *(US-UX01, US-UX02, US-UX03, US-UX04, US-UX05, US-UX06)* — *Removes the top bar; role-based landing; concept-named nav (Vender·Escáner·Ventas·Caja·Hoy); avatar account surface for identity/logout/overflow; one-verb CTA sweep; Caja drops badge. Frontend-only.* — `docs/navigation/app-shell-redesign.spec.md`
- [x] **Service-Based Commission (percent or fixed per spot)** *(US-A12 rev., US-A33)* — *Commission moves from the seller to the service; any seller earns identically. Migration 0030 backfills the old bonus as the rate; per-agent `base_commission` retired.* — `docs/commissions/service-based-commission.spec.md`

**🟡 SHOULD HAVE** *(Reorg Phase 2 — the real "Hoy")*
- [ ] **Daily Operations Dashboard as "Hoy"** *(US-A14, US-A15, US-A16, US-AG26)* — *Replaces the interim queue-card Hoy with the spec'd occupancy + day's-sales dashboard; folds the agent snapshot into the agent's Caja.* — `docs/dashboard/occupancy-dashboard.spec.md`

**🔵 COULD HAVE** *(Reorg Phase 3 — overflow grows + cleanup)*
- [ ] **Configuración home** *(US-A29)* — *Edit the org acknowledgment window and the admin's own base commission.*
- [x] **Reportes home** *(US-A17, US-A18, US-A20)* — *Commission & settlement / performance reports + CSV/print export, per seller (agent + affiliate), reached from the account surface.* — `docs/reports/commission-report.spec.md`
- [ ] **Screen unification** — *Merge the duplicate Ventas (Folios/Historial) and folio-detail page pairs into single role-aware components.*

#### 🔵 COULD HAVE
*Nice-to-have features that improve UX if extra time is available.*
- [ ] **Report export (PDF/CSV)** - *Moved from Out of MVP if time permits.*

#### 🔴 WON'T HAVE THIS TIME
*Features explicitly discarded for the MVP.*
- [ ] **Integrated card payments (Stripe, Conekta)** - *Payment integration complexity*
- [ ] **Client self-service online purchase** - *Requires payment gateway and checkout flow*
- [ ] **Native App (iOS / Android)** - *Mobile-first PWA is sufficient for Phase 1*
- [ ] **Discarded: WhatsApp API Integration** - *For cost and speed, ticket delivery is handled via Email instead of WhatsApp.*
- [ ] **Multiple payment methods (card, wire transfer)** - *Cash only in Phase 1*

---

## Key Business Rules

### Inventory

- Each slot (service + date + time) has a `max_capacity` defined by the admin.
- A service is either **Hard Cap** (`is_flexible = false`, the default) or **Soft Cap** (`is_flexible = true`) — US-A36. For Soft Cap, a slot's **Effective Capacity** = `max_capacity + floor(max_capacity × flex_capacity_pct / 100)`; for Hard Cap it equals `max_capacity` exactly. `flex_capacity_pct` is stored per service and must fall within the org-configured range (default min 1 % / max 30 %). *(Open: floor vs round on the margin — defaulting to `floor` so the flex never exceeds the stated tolerance.)*
- Upon confirming a sale (including bookings), the spots are deducted immediately.
- The POS enforces sales against the slot's **Effective Capacity**: Hard Cap blocks above `max_capacity`; Soft Cap allows the extra margin and blocks above Effective Capacity.
- If the (effective) capacity reaches 0 at the time of confirmation (race condition), the sale is rejected with a clear error.
- Upon cancelling a folio, all spots for the involved slots are released.
- **Catalog availability is windowed and boolean** (US-AG30): the POS catalog read reports only `has_availability` per service — `true` when ≥ 1 active slot has effective remaining > 0 inside the **availability window** (the semantic date range currently selected, e.g., Monday to Sunday). The exact per-slot remaining count is computed only on the service-detail read, never in the catalog list.
- **Bottom Sheet slot matrix is a 3-day window** (US-AG33): when the agent opens a service, the detail read is scoped to `[anchor, anchor+2]` (`anchor = selectedDate ?? today`), and the slots render as a 3-row day matrix. A day with no slot whose effective remaining seats the current party renders disabled as **"(Agotado)"**.
- **Cushion (overbooking) warning is party-aware** (US-AG34): a Soft Cap slot is flagged orange — **"Usando X cupos extra"** (`X = partySize − slot.remaining`) — exactly when `slot.remaining < partySize ≤ Effective Capacity`. It is advisory: the POS still enforces the Effective Capacity ceiling atomically at confirmation (race-condition protection unchanged).
- **Accommodation uses a date-range count inventory, not slots** (US-A59–A63 / US-AG36–38 — `docs/lodging/accommodation-stays.spec.md`): a `lodging` service owns **unit types** with an `inventory_count`; a stay reserves a **quantity of a type** for the nights `[check_in … check_out)` (**standard hotel turnover** — the check-out day is reusable same-day). Per night, `remaining = inventory_count − Σ active reservation quantities − Σ block-out quantities`; a type is available for a range only when `remaining ≥ requested quantity` on **every** night (a naive SUM over overlapping reservations over-counts — forbidden), the party fits `max_capacity × quantity`, and `nights ≥ min_nights`. Confirming a stay inserts a reservation under a **per-night atomic count guard** (concurrent oversell → `409 INSUFFICIENT_INVENTORY`); cancel/expiry releases the quantity. Physical room assignment is out of scope (POS, not PMS). Lodging services never use slots/schedules.
- **Zoned capacity partitions a slot's seats, opt-in** (US-A64 — `docs/catalog/zoned-capacity.spec.md`): when `services.zones_enabled = 1`, a slot's seats are divided among **2–6 named zones**. Each departure gets one `slot_zones` row per zone with a **snapshotted `capacity`** (frozen per departure, so editing a zone never rewrites past departures) and its own `booked`; the rows are **created eagerly** for future slots (at enable, and in the same atomic batch whenever a new slot is materialized). A sale into a zone is guarded by the same **single-statement atomic UPDATE** against the row's snapshotted capacity (concurrent oversell → `409 ZONE_UNAVAILABLE`); `slots.capacity`/`slots.booked` are **reconciled** as the sum over open zones, so every existing availability read, the sweep and the cancel/re-block paths keep working unchanged. A zone may be **closed for one departure** (blocks new sales; sold seats stay valid). Zoned services cannot also be Soft Cap (US-A36). Same price/commission across zones — a partition of seats, never of money.

### Pricing and Discounts

- Each service has a `base_price` and a `minimum_price` (both defined by the admin).
- The agent can reduce the price down to the `minimum_price`, inclusive. Below this, the system blocks the sale.
- Extras have a fixed price; no discounts are applied to them.
- **Accommodation is priced per night, per room** (US-A60/D12 — `docs/lodging/accommodation-stays.spec.md`): a stay line total = Σ over each of the `quantity` rooms of (Σ over each night of the type's nightly rate + an extra-person surcharge above the base occupancy), with total guests **split across rooms as evenly as possible** (e.g. 5/2 → 3+2). Per night the rate resolves **seasonal override > weekend rate > base rate** (weekend days org-configurable, default Fri+Sat). Per-night manual discounting is out of scope. Paid-stay cancellations follow a **structured free-window + penalty %** (US-A63); apartado deposits on a stay stay non-refundable (US-AG07.4).

### Commissions

> **Service-based model** (rev. 2026-06-11 — `docs/commissions/service-based-commission.spec.md`).
> Commission belongs to the **service sold**, not to the seller; agents and admins earn
> identically for identical sales. The per-agent `base_commission` is retired.

- Each service defines `commission_type` (`percent` | `fixed`) and `commission_value`
  (basis points for percent; minor units **per spot** for fixed), set by the admin in the catalog.
- Commission per sales line: **percent** → `round(line_total × commission_value / 10000)`,
  where the line total includes the line's extras and reflects any discount;
  **fixed** → `commission_value × quantity`, independent of discounts and extras.
- A fixed `commission_value` must not exceed the service's `minimum_price`, so commission can
  never exceed the revenue of even a maximally-discounted pass.
- The folio's commission is the sum of its line commissions, **snapshotted at POS** — later
  catalog edits never rewrite sold folios.
- Bookings/down-payments (when built): percent commissions accrue on the amount actually
  collected; fixed commissions accrue when the folio reaches `paid`.
- **Affiliate commission (when built):** an `affiliate` seller earns the per-affiliate, per-service
  rate in their `affiliate_commissions` row (US-A50 / US-A56). That row is also the affiliate's
  **allow-list** — a service with no row is not shown or sellable in their POS, so there is **no
  fallback to the service's standard commission**. It follows the same math as any commission
  (**percent** on the discounted line total; **fixed** × quantity), is snapshotted on the folio at
  sale, and — like an agent's — **reduces the affiliate's running balance** (the cash they hand in
  is collected − commission). The folio's `affiliate_company_id` attributes the sale (US-A51).

### Bookings (Down-payment / Partial Payment)

- A booking reserves the slot capacity just like a full sale.
- The agent registers the received amount (`booking_amount`) and the pending balance is calculated automatically.
- The folio remains in a `booking` state until the remaining balance is collected, transitioning to `paid`.

### Customer Contact

- **Name and a dialable phone are required; email is optional** *(Rev. — WhatsApp QR Delivery,
  D2)*. WhatsApp is now the primary ticket-delivery channel (the agent sends the portal link),
  so the POS requires a customer **name** and a **phone** — normalized to an international number
  (default +52) — and rejects a confirmation missing either (`400`); the confirm button stays
  disabled until both are valid, uniformly for **every role** (agent, admin, affiliate).
- **Email is now optional.** When present it must be a valid address and still receives the ticket
  + portal link (an optional copy); a sale **without** an email is allowed — the tourist gets the
  tickets over WhatsApp. *(Supersedes the earlier email-mandatory rule; an affiliate sale is
  customer-direct — the affiliate no longer receives a self-addressed copy. See
  `docs/whatsapp-qr-delivery/spec.md`.)*

### QR and Access Validation

- **Group Tickets (Partial Redemption):** A single QR code is generated per service in a folio, representing the total number of spots purchased (e.g., 5 passes for 5 friends). Each successful scan redeems exactly 1 pass. If the QR is scanned after all passes have been consumed, it throws an "✗ Invalid (All passes consumed)" error.
- **Prepared for Offline:** The QR contains a JSON payload signed with HMAC-SHA256 using a `QR_SECRET` per organization. This structure guarantees that Phase 2 offline validation can be implemented securely without changing the issued tickets.
- The payload includes: `folio_id`, `service_id`, `slot_id`, `client_identity`, `expires_at`. (The server knows the total purchased spots based on the folio).
- **Phase 1 (Strictly Online):** The agent app validates the QR exclusively against the server. The server tracks the redemption count in real-time. If there is no internet connection, the system throws a network error to the agent, refusing the scan.
- **Phase 2 (Offline capabilities):** Offline validation will verify the signature locally (invalid signature → ✗ Fake). Consumed tickets will be stored in `localStorage` of the scanning agent's device and synced to the server (`POST /api/tickets/sync`) once connection is restored. The server remains the single source of truth.

### Multitenancy

- All data (services, agents, folios, slots) belongs to an `organization_id`.
- An agent can only view and sell services from their own organization.
- The admin only manages their own organization.

---

## External Integrations

| Service | Purpose |
|---|---|
| **Agnostic Auth** (Cloudflare Worker) | JWT issuance for sessions (internal token generator) |
| **Resend** | Transactional emails: admin verification, agent invitation, password reset, and **client ticket delivery** |
| **Cloudflare D1** | Primary database (SQLite) |
| **Cloudflare Workers** | Backend runtime (Hono) |

---

## Glossary

| Term | Definition |
|---|---|
| **Folio** | Record of a complete sale. Can include one or more services. Has a unique ID and one QR code per service. |
| **Slot** | An instance of a service at a specific date and time, with its own maximum capacity. |
| **Extra** | Optional product or service added to a folio (e.g., photo, insurance). |
| **Booking (Apartado)** | Folio with a partial payment that reserves capacity but remains pending complete collection. |
| **Running balance (Bolsa / Saldo)** | An agent's perpetual balance of company cash held: Σ collected − Σ expenses − Σ confirmed cash drops. No daily boundary. |
| **Cash drop (Entrega de efectivo)** | An event where an agent hands physical cash to the admin; once the admin confirms receipt it reduces the agent's running balance. |
| **Cash closure (Corte de caja)** | *Deprecated (Phase-1 pivot).* The earlier daily summary model — replaced by the continuous running balance + cash drops. |
| **Minimum price (Precio mínimo)** | Price floor per service defined by the admin. The agent cannot sell below it. |
| **Hard Cap (Cupo estricto)** | Default capacity mode for a service (`is_flexible = false`): the POS never allows more spots than the slot's `max_capacity`. |
| **Soft Cap / Flexible Cap (Cupo flexible)** | Capacity mode (`is_flexible = true`) that permits controlled overbooking up to a per-service tolerance (`flex_capacity_pct`), letting sellers capture last-minute demand. The tolerance must fall within the org-configured range (default 1–30 %). |
| **Effective Capacity (Cupo efectivo)** | The real ceiling the POS enforces for a slot: `max_capacity` for Hard Cap, or `max_capacity + floor(max_capacity × flex_capacity_pct / 100)` for Soft Cap. Computed live as the agent adjusts the people counter (US-A36). |
| **Service Category (Categoría)** | A service's single primary type, drawn from a closed enum (`lodging`, `tours`, `dining`, `adventure`, `culture`). Stored as `services.category`; required on create/edit. Drives the POS catalog filter chips — a chip appears only for a category that has ≥ 1 available service (US-A37). |
| **Availability window** | The date range the POS catalog evaluates `has_availability` over: bounded by the dynamic week-based context (`ESTA SEMANA` / `ESTE FIN`) or the explicit selection made in the calendar. |
| **Inline Filter Strip** | The `/pos` catalog's single horizontally scrollable row containing category chips, a visual divider, and the dynamic date filters (`ESTA SEMANA` / `ESTE FIN` + Calendar). Replaces the old `quick-day strip` and `category sheet` (US-AG35). |
| **Calendar Bottom Sheet (Calendario)** | The Bottom Sheet opened from the quick-day strip's calendar button: a **month grid of square day chips** marking the **available days** (sellable days selectable, past/empty days disabled) with **month navigation**. Day marks come from the lightweight org-scoped `GET /api/pos/availability/days`. Picking a day sets `selectedDate` and closes the sheet (US-AG35). |
| **Bottom Sheet (Panel de venta)** | The animated panel that slides up from the bottom of the POS catalog when an agent taps a service card (US-AG31), carrying the sale-configuration interface (People control, reactive slot matrix, discount, extras, *Agregar al carrito*) without leaving the catalog. Auto-closes on a successful add, handing back a *Ver carrito* Snackbar. Re-homes the former full-page service-detail flow. |
| **People-first slot filter** | The Bottom Sheet behaviour where the People control `[ − 1 + ]` is the first input and reactively hides any time slot that cannot seat the whole group, keeping only slots with `effectiveRemaining ≥ partySize` (US-AG32, mapping the story's `slot.remaining + slot.max_extra_seats` onto the Effective Capacity margin of US-A36). |
| **Date/Time matrix (Matriz de horarios)** | The Bottom Sheet's slot view (US-AG33): a 3-row matrix for the inherited day and the next two (`[anchor, anchor+2]`), each row a relative day label (`Hoy` / weekday) followed by flex-wrapping time-slot chips, with a muted **"(Agotado)"** label when a day has no slot that fits the current party. |
| **Cushion warning (Aviso de sobreventa)** | The orange state a Soft Cap slot chip takes when the chosen party dips into its overbooking margin — `slot.remaining < partySize ≤ Effective Capacity` — showing **"Usando X cupos extra"** (`X = partySize − slot.remaining`). Advisory only; never blocks the add (US-AG34). Supersedes the earlier party-independent flex highlight. |
| **`has_availability`** | The boolean the POS catalog payload carries per service (replacing the Σ-remaining spot count): `true` when the service has ≥ 1 active slot with effective remaining > 0 inside the availability window. Keeps the catalog read lightweight — no slot details, no count (US-AG30). |
| **Service Creation Wizard (Asistente de creación)** | The full-screen, 4-step modal for building a complete service in one pass (US-A38–A44): Basic info → Pricing & commission → Availability & departure times → Extras → *Guardar*. Re-homes the former split create-dialog + detail-page configuration; create-only (edit keeps the existing dialog). Orchestrates the existing catalog/slots/schedules/extras endpoints — no new service field. |
| **Quick-select date presets** | Step-3 convenience chips (*Resto del año*, *Resto del mes*, *Fines de semana*) that fill the recurring schedule's `start_date` / `end_date` (anchored on the device-local *hoy*) and/or preselect weekdays, so an operator sets a common recurrence in one tap (US-A41). Frontend-only; bounded by the existing `MAX_HORIZON_DAYS` (1 year) cap. |
| **Departure times (Horarios de salida)** | The set of wall-clock start times an operator attaches to a service in the Wizard's Step 3 (US-A42). Each distinct time becomes one slot (single date) or one recurring schedule (recurrence) at save, so "9:00 + 12:00" on a Mon/Wed recurrence materializes two schedules. Entered as deduplicated removable pills. |
| **Affiliate (Afiliado)** | An external reseller (hotel, travel agency, restaurant) who sells the operator's services under a per-affiliate negotiated commission and sends groups. Sells, discounts to the minimum price, and books apartados like an agent, collecting cash and carrying a running balance settled by deposit/transfer — but **cannot scan QRs or record expenses**; belongs to one affiliate company (US-AF01–US-AF09). |
| **Affiliate company (Empresa afiliada)** | The partner-business entity an affiliate user belongs to (name, contact, status). Carries the per-service commissions / allow-list and is the unit sales are attributed to for separating in-house vs affiliate revenue (US-A48 / US-A51). |
| **Affiliate commission (Comisión de afiliado)** | A per-affiliate, per-service commission — percent of the sold price or fixed per spot — the admin sets in the Affiliate Setup Wizard (US-A50 / US-A56). Its `affiliate_commissions` row also **gates the affiliate's catalog**: a service with no row is not visible or sellable, so there is **no fallback** to the service's standard commission (US-A12). |
| **Affiliate allow-list (Catálogo del afiliado)** | The set of services an affiliate may sell — exactly the services with an `affiliate_commissions` row for their company (enabled in Wizard Step 2, US-A56). The affiliate POS shows only these; the full catalog is never exposed. |
| **Affiliate Setup Wizard (Asistente de afiliados)** | The full-screen, 3-step modal for registering an affiliate company in one pass (US-A54–A57): Company info → Catalog & commissions (curate sellable services + set each rate) → Invitations → *Finalizar*. Mirrors the Service Creation Wizard; create-only. Orchestrates US-A48/A49/A50. |
| **Service commission (Comisión del servicio)** | The commission defined on each catalog service — a percentage of the sold price or a fixed amount per spot — earned identically by any seller (agent or admin). Replaced the earlier per-agent base % + per-service bonus (rev. 2026-06-11). |
| **Clawback** | On cancelling a folio, the admin's choice (US-A26) to make the agent **forfeit** the commission booked on that sale (vs. the company absorbing the loss). Recorded as `cancellation_clawback` on the folio and applied by the running-balance derivation. |
| **Direct collection (Cobro directo)** | A cash collection the admin records face-to-face (US-A27): a `confirmed` drop created by the admin that reduces the agent's balance immediately and owes the agent a signature. |
| **Acknowledgment window (Ventana de firma)** | Per-organization period (default 24 h, range 1–168 h — US-A29) during which an agent can sign or dispute a unilateral admin money-move (direct collection / adjusted drop) before it auto-signs. An open dispute is never auto-signed. |
| **Magic Link** | A signed, time-limited tokenized URL emailed to a tourist that grants passwordless access to their self-service booking portal (Phase 2). |
| **Refund PIN** | A secure code shown to a tourist in the portal once their cancellation is approved; the tourist gives it to the agent/admin to confirm the physical cash refund was received, closing the cash-refund loop (US-T05 ↔ US-A23). |
| **Self-authorized settlement** | A cash drop or payout created by the admin against their **own** balance: because the hand-in party and the approving party are the same person, the event is born `confirmed` (`reviewed_by = self`), skips the pending-review queue, and opens no acknowledgment window. The balance derivation is unchanged — only the approval *step* is skipped (US-A34). Surfaced as an "auto-confirmada" label. |
| **Tu caja / Equipo** | The two sections of the admin's **Caja** screen: **Tu caja** is the admin's own drawer (their sales' cash collected, commission, and net to hand in, with an *Entregar* action) pinned above **Equipo**, the agents' balances and pending-drop review queue (US-A35). |
| **Zone (Zona)** | A named physical subdivision of a slot-based service's seats (e.g. a Turibus's *Piso alto* / *Piso bajo*), each with its own seat count — a **pure inventory partition** (same price/commission/extras across zones). Opt-in per service (`services.zones_enabled`); 2–6 zones. Agents sell a specific zone and no area is overbooked (US-A64). Mutually exclusive with Soft Cap. |
| **`slot_zones`** | The per-departure zone inventory row (US-A64): one per (slot, zone), carrying a `capacity` **snapshotted** from the zone at creation (frozen per departure, so editing a zone never rewrites past departures) plus its own `booked`. A sale is guarded by a single-statement atomic `UPDATE` against this row (`409 ZONE_UNAVAILABLE`); `slots.capacity`/`booked` are **reconciled** as the sum over open zones, so every existing availability read is untouched. `status = 'inactive'` = closed for that one departure (the rain case) — new sales blocked, sold seats stay valid. |
