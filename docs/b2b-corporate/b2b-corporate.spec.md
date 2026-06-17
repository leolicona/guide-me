# B2B Corporate Partners & Credit Bookings — Spec

**Feature:** A self-service portal for commercial partners (hotels, travel agencies) who send
tourist groups. Partners create their own folios on **credit** — booking the spots, receiving the
scannable QRs **even while unpaid**, and settling the balance with the operator on a later
accounting cut-off. Builds directly on the Bookings / Down-payments architecture.
**Stories:** US-CORP.1 (role & portal), US-CORP.2 (credit booking + limit), US-CORP.3 (QR + tolerant
scan), US-CORP.4 (admin debt dashboard & settle), US-CORP.5 (partner/rate/credit admin),
US-CORP.6 (negotiated pricing at checkout).
**Status:** Specification. SHOULD HAVE. (Realizes the **deferred B2B phase** of
`docs/bookings/bookings-down-payments.spec.md` §1.2.)
**Owner module:** new `api-guideme/src/routes/corporate/`; touches `routes/pos/`, `routes/tickets/`,
`middleware/role.ts`, `db/schema.ts`; new `app-guideme/src/features/corporate/`.

---

## 1. Context & Architecture

Today a hotel concierge phones the administrator to hold spots for a group, leaves a deposit, and
the balance is chased days **after** the tour. This feature makes that self-service and integrates
it with the booking engine.

A **B2C tourist** must pay 100% before any QR is issued and the scanner refuses any non-`paid`
folio (`tickets/handler.ts:94-100`). A **B2B credit booking** inverts two of those rules:

1. The QRs are **minted at creation**, not deferred to settle — so the group can board on tour day
   regardless of the outstanding balance.
2. The scanner **admits a `booking` folio when it carries the credit flag** — a narrow, explicit
   exemption to the "paid only" gate.

Everything else (atomic inventory decrement, cart pricing, one-shot settle, multitenancy isolation)
is **reused verbatim** from the existing POS / bookings code.

### 1.1 Confirmed decisions (2026-06-17)

| # | Topic | Decision |
|---|---|---|
| C1 | **Account model** | **Admin-invited.** An operator admin creates `corporate` users *inside the operator's own organization*. No public signup. A corporate user is a role-limited member of the org → multitenancy isolation is unchanged. |
| C2 | **Partner entity** | A **separate `corporate_partners` table** holds credit limit, contact, status, and is the unit of debt. One partner ↔ many `corporate` login users (a hotel's concierges share one credit line). The user row links via `corporate_partner_id`. |
| C3 | **Credit governance** | **Per-partner credit limit** (`credit_limit`, minor units). A new credit booking is rejected when `outstanding_debt(partner) + folio_debt > credit_limit`. |
| C4 | **Pricing** | **Per-service net-price overrides per partner** (`corporate_partner_rates`). A service with no override falls back to its public price. |
| C5 | **Credit access** | Corporate folios are stamped `scan_allowed_unpaid = true`. QRs are **issued at creation**; the scanner admits `status='booking' AND scan_allowed_unpaid=true`. |
| C6 | **Settlement** | **One-shot, admin-only.** Reuses the **same settle logic** as B2C bookings (`amount_paid` jumps to `total`, `settled_at/by` audit). The corporate user **cannot** settle; the partner pays offline at the cut-off and the admin registers it. |
| C7 | **Debt visibility** | **Shared, asymmetric.** The corporate user sees **their own partner's** folios & balances ("Mis reservas"); the admin sees the **whole org's** corporate debt (cobranza dashboard). Only the admin can act (settle). |
| C8 | **No auto-expiry** | A credit booking has **no `booking_expires_at`** and is **excluded from the expiry sweep** — a post-payment agreement never releases spots. (Contrast B2C bookings, which auto-expire.) |
| C9 | **Commission** | Corporate self-service folios earn **no agent commission** (`commission_amount = 0`); there is no field agent in the loop. |

### 1.2 Scope of THIS implementation (phasing)

| In scope now | Deferred (later phase) |
|---|---|
| `corporate` role + admin-invited users; `corporate_partners` + `corporate_partner_rates`; per-partner credit limit + net rates | **Self-signup / partner approval queue**; **flat global discount %** as an alternative to per-service rates |
| Credit folio creation (deposit 0–partial), QR-at-creation, scanner exemption, sweep carve-out | **Partner self-pay online** (settle from the portal) — admin-only this phase (C6) |
| Admin debt/cobranza dashboard + one-shot admin settle; partner & rate management UI | **Statements / invoices / aging exports**, **automatic dunning** beyond the dashboard |
| Corporate portal: catalog (net prices) + credit checkout + "Mis reservas" with ready QRs | **Per-partner payment terms automation** (net-30 schedules, late fees) |

### 1.3 Builds on / reserved rules (honoured verbatim)

| Reserved by | Rule | Where here |
|---|---|---|
| `bookings-down-payments.spec.md` §1.2 | B2B `scan_allowed_unpaid` = scanner exemption + expiry carve-out + governance — **this is that phase**. | C5, C8, §3, §4 |
| `bookings-down-payments.spec.md` §4.3 | One-shot settle (`amount_paid→total`, `settled_at/by`). | C6, US-CORP.4 |
| `scanner/online-qr-scanner.spec.md` | Scanner refuses non-`paid` folios. | **Narrowly relaxed** for credit folios only (US-CORP.3) |
| POS confirmSale | Atomic inventory decrement + compensation; cart pricing; `finalizePaidFolio` (QR + portal token + ticket email). | Reused at creation (US-CORP.2) |
| Multitenancy (`docs/ARCHITECTURE.md`) | Every tenant-scoped row carries `organization_id`; no `organization_id`/`status`/`total` in request bodies; cross-org isolation tests via `seedTwoOrgs`. | §3, §4, §7 |

---

## 2. Detailed User Stories & Acceptance Criteria

### US-CORP.1 — Corporate role & self-service portal

> **As a** Corporate Partner (hotel concierge / travel agency)
> **I want** my own login to a tailored portal
> **So that** I can check availability and place group orders without phoning the operator.

#### Acceptance Criteria
- **AC1:** A new system role `corporate` exists (`users.role` enum) and `requireRole` accepts it.
- **AC2:** A `corporate` user is created **only by an admin** (C1), is a member of the admin's
  organization, and is linked to exactly one `corporate_partner` (`users.corporate_partner_id`).
- **AC3:** A `corporate` user authenticating lands on the **corporate portal** (`/corporate`), not
  the agent POS or admin panel. Role-gated routing on both client and API.
- **AC4:** The portal exposes a **catalog with availability** (reuses the lightweight POS
  availability query) and a **checkout** — and nothing else (no cash drawer, no commissions, no
  admin settings, no other partners' data).
- **AC5:** A `corporate` user can read/write **only their own partner's** folios and rates
  (caller-partner-scoped); cross-partner and cross-org access returns `404`.

```gherkin
Escenario 1: Acceso restringido al portal corporativo
  Dado que un usuario con rol "corporate" inicia sesión
  Cuando el sistema resuelve su sesión
  Entonces es dirigido al portal /corporate
  Y no puede acceder a las rutas de agente, administrador ni a datos de otro socio.

Escenario 2: Catálogo con disponibilidad
  Dado que un concierge abre el portal
  Cuando carga el catálogo
  Entonces ve los servicios con su disponibilidad por fecha (misma consulta ligera del POS).
```

---

### US-CORP.2 — Credit booking with partial or 100% debt (+ credit limit)

> **As a** Corporate Partner
> **I want** to place an order paying a deposit, or nothing upfront
> **So that** I secure the group's spots under our post-payment agreement.

#### Business rules
- **Status:** the folio enters in `status = 'booking'` with `scan_allowed_unpaid = true` and
  `corporate_partner_id` set (C2/C5). **No `booking_expires_at`** (C8).
- **Down payment:** `down_payment` is **optional**, `0 ≤ down_payment ≤ total`. Corporate
  **bypasses** the org `booking_min_down_payment_pct` floor (a hotel may book 100% on credit).
  - `down_payment == total` → a fully-paid folio (`status='paid'`, no debt) — still a corporate
    folio with QRs; no settle needed.
  - `0 ≤ down_payment < total` → credit folio; `amount_paid = down_payment`,
    `pending_balance = total − down_payment`.
- **Inventory:** spots are **decremented atomically at creation** (US-CORP.1 reuse of confirmSale's
  guarded decrement + compensation). A capacity failure → `409 NO_CAPACITY_AVAILABLE`.
- **Credit limit (C3):** let `folioDebt = total − down_payment` and
  `outstanding = Σ(total − amount_paid)` over the partner's `status='booking'` credit folios.
  If `outstanding + folioDebt > partner.credit_limit` → **`409 CREDIT_LIMIT_EXCEEDED`**
  (body echoes `credit_limit`, `outstanding`, `available`). Checked **before** the decrement.
- **Suspended partner:** `partner.status='suspended'` → `403 PARTNER_SUSPENDED`.

#### Acceptance Criteria
- **AC1:** A credit folio is created in `booking` state with `scan_allowed_unpaid=true`, inventory
  decremented, `commission_amount=0` (C9).
- **AC2:** Pricing uses the **partner's net rates** (US-CORP.6) to compute `total`.
- **AC3:** The credit-limit check rejects a folio that would push the partner over their limit,
  **without** decrementing inventory.
- **AC4:** A `down_payment` of `0` is valid (100% credit); `down_payment > total` → `400`.

```gherkin
Escenario 1: Reserva a 100% crédito dentro del límite
  Dado un socio con límite $50,000 y adeudo actual $10,000
  Y un carrito con total $8,000
  Cuando el concierge confirma la reserva sin anticipo (down_payment = 0)
  Entonces el folio se crea en estado "booking", scan_allowed_unpaid=true,
  el inventario se descuenta y el saldo pendiente es $8,000.

Escenario 2: Límite de crédito excedido
  Dado un socio con límite $50,000 y adeudo actual $45,000
  Y un carrito con total $8,000 (sin anticipo)
  Cuando el concierge intenta confirmar
  Entonces el sistema responde 409 CREDIT_LIMIT_EXCEEDED, no descuenta inventario
  Y muestra el crédito disponible ($5,000).

Escenario 3: Anticipo parcial
  Dado un carrito con total $8,000
  Cuando el concierge paga $3,000 de anticipo
  Entonces amount_paid=$3,000, saldo pendiente=$5,000, estado "booking".
```

---

### US-CORP.3 — QR issuance & tolerant (credit) access

> **As an** Administrator / Scanner Operator
> **I want** the group to board on tour day even with a pending balance
> **So that** the experience is smooth and we collect at the cut-off.

#### Acceptance Criteria
- **AC1:** A credit folio mints **per-line QR + portal token at creation** (reuses
  `finalizePaidFolio`) — the partner sees ready tickets immediately, regardless of balance.
- **AC2:** **Scanner exemption** — `scanTicket` admits a folio when
  `status === 'paid' OR (status === 'booking' AND scan_allowed_unpaid === true)`. All other gates
  (signature, `cancelled` → `CANCELLED`, expiry, atomic single-redeem) are **unchanged**.
- **AC3:** A non-credit `booking` (B2C, `scan_allowed_unpaid=false`) still returns `NOT_PAID`
  (and has no QR anyway) — the exemption is flag-scoped, not status-scoped.
- **AC4:** A `cancelled` corporate folio returns `CANCELLED` (the flag never overrides cancellation).
- **AC5:** The ticket email on a credit folio is addressed to the **partner contact** so they can
  distribute QRs to the group.

```gherkin
Escenario 1: Acceso tolerante en día de tour
  Dado un folio corporativo en estado "booking" con scan_allowed_unpaid=true y saldo pendiente
  Cuando el operador escanea un QR de ese folio el día del tour
  Entonces la validación es exitosa y se redime un pase (igual que un folio pagado).

Escenario 2: La exención no aplica a reservas B2C
  Dado un folio "booking" B2C con scan_allowed_unpaid=false
  Cuando se escanea (si tuviera QR)
  Entonces el resultado es NOT_PAID.

Escenario 3: Cancelado siempre se rechaza
  Dado un folio corporativo cancelado
  Cuando se escanea un QR
  Entonces el resultado es CANCELLED.
```

---

### US-CORP.4 — Admin debt (cobranza) dashboard & settlement

> **As a** GuideMe Administrator
> **I want** to see corporate bookings with a pending balance — especially tours already run —
> **So that** I manage collections and mark folios `paid` once the money lands.

#### Acceptance Criteria
- **AC1:** An org-wide list of corporate credit folios (`status='booking' AND scan_allowed_unpaid=true`),
  with `partner_name`, `pending_balance`, `tour_date` (earliest line slot), and an **aging flag**
  (`past_event = earliest slot < today`). Filterable by partner.
- **AC2:** Default sort surfaces collection priority: **past-event first**, then by `tour_date ASC`.
- **AC3:** **Settle is admin-only** (C6) and reuses the existing **one-shot settle**:
  `status→'paid'`, `amount_paid→total`, `settled_at/by`. Because QRs were minted at creation, settle
  is **QR-idempotent** — it does **not** re-mint or re-send tickets.
- **AC4:** Settling reduces the partner's `outstanding` by that folio's prior `pending_balance`,
  freeing credit headroom.
- **AC5:** Settle guards: already `paid` → `409 ALREADY_SETTLED`; `cancelled` → `409 FOLIO_CANCELLED`;
  foreign org → `404`. A `corporate` caller hitting settle → `403`.

```gherkin
Escenario 1: Tablero de cobranza priorizado
  Dado que existen folios corporativos a crédito, algunos de tours ya realizados
  Cuando el administrador abre el tablero de cobranza
  Entonces ve las tarjetas ordenadas con los tours ya realizados primero,
  cada una con el socio, el saldo pendiente y un indicador de "evento pasado".

Escenario 2: Liquidación por el administrador
  Dado un folio corporativo con saldo pendiente $5,000
  Cuando el administrador registra el pago y liquida
  Entonces el folio pasa a "paid", amount_paid=total, se registra settled_at/by,
  no se re-emiten QRs, y el crédito disponible del socio aumenta en $5,000.

Escenario 3: El socio no puede liquidar
  Dado un usuario corporate
  Cuando intenta liquidar un folio
  Entonces recibe 403 (solo el administrador liquida).
```

---

### US-CORP.5 — Admin: partner, rate & credit management

> **As an** Administrator
> **I want** to register corporate partners, set their credit limit and negotiated prices, and
> invite their users
> **So that** the commercial agreement is enforced automatically.

#### Acceptance Criteria
- **AC1:** Create / edit a `corporate_partner` (`name`, `contact_email`, `contact_phone`,
  `credit_limit`, `status`). All org-scoped.
- **AC2:** Set **per-service net prices** (`corporate_partner_rates`): a bulk upsert of
  `{ service_id, net_price }` rows for a partner. Removing a row reverts that service to public price.
- **AC3:** **Invite a `corporate` user** linked to a partner (reuses the existing agent-invite flow
  with `role='corporate'` + `corporate_partner_id`). The same email can never belong to two orgs.
- **AC4:** Suspending a partner (`status='suspended'`) blocks **new** credit bookings
  (`403 PARTNER_SUSPENDED`) but leaves existing folios and their QRs intact.
- **AC5:** Validation: `credit_limit ≥ 0`; `net_price ≥ 0`; a rate's `service_id` must belong to the
  org (else `400`).

```gherkin
Escenario 1: Alta de socio con límite y tarifas
  Dado un administrador en su organización
  Cuando crea el socio "Hotel Marquis" con límite $50,000
  Y define tarifas netas por servicio (p. ej. Tour Prismas a $450 en vez de $600 público)
  Entonces el socio queda activo y sus tarifas se aplican a sus reservas.

Escenario 2: Suspensión de socio
  Dado un socio con reservas activas
  Cuando el administrador lo suspende
  Entonces no puede crear nuevas reservas a crédito (403 PARTNER_SUSPENDED)
  Y sus folios y QRs existentes siguen siendo válidos.
```

---

### US-CORP.6 — Negotiated pricing applied at checkout

> **As a** Corporate Partner
> **I want** my negotiated prices reflected automatically
> **So that** the order total matches our agreement with no manual adjustment.

#### Acceptance Criteria
- **AC1:** At cart time the server resolves each line's unit price as
  `resolveCorporateUnitPrice(service, partner) = partner_rate.net_price ?? service.publicPrice`.
- **AC2:** The `total` is computed **server-side** from the resolved unit prices (the client never
  sends prices — Multitenancy Rule 1). The portal **displays** the same net prices for transparency.
- **AC3:** A service without a partner override uses the public price.
- **AC4:** The net price is **snapshotted** onto the `folio_line` at creation, so a later rate change
  never retro-shifts an existing folio (mirrors the commission/price snapshot rule).

```gherkin
Escenario 1: Tarifa neta aplicada
  Dado un socio con tarifa neta $450 para "Tour Prismas" (público $600)
  Cuando agrega 4 lugares de ese tour
  Entonces el total de la línea es $1,800 (4 × $450), no $2,400.

Escenario 2: Servicio sin override usa precio público
  Dado un socio sin tarifa para "Tour Cascadas" (público $300)
  Cuando agrega 2 lugares
  Entonces el total de la línea es $600 (precio público).
```

---

## 3. Data model changes

**Additive only** — two new tables, one new enum value, four new nullable columns. No table rebuild;
existing B2C folios read back with `scan_allowed_unpaid=0` / `corporate_partner_id=null`.

### New table `corporate_partners`
```ts
export const corporatePartners = sqliteTable('corporate_partners', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  creditLimit: integer('credit_limit').notNull().default(0),          // minor units (C3)
  status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
```
> `outstanding_debt` is **derived** (Σ `total − amount_paid` over the partner's `status='booking'`
> credit folios), not stored — no denormalised counter to drift.

### New table `corporate_partner_rates` (per-service net price override — C4)
```ts
export const corporatePartnerRates = sqliteTable('corporate_partner_rates', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  partnerId: text('partner_id').notNull().references(() => corporatePartners.id),
  serviceId: text('service_id').notNull().references(() => services.id),
  netPrice: integer('net_price').notNull(),                           // minor units, per spot
}, (t) => ({ uq: unique().on(t.partnerId, t.serviceId) }))
```

### `users` (extended)
```ts
role: text('role', { enum: ['admin', 'agent', 'corporate'] }).notNull(),       // + 'corporate'
corporatePartnerId: text('corporate_partner_id').references(() => corporatePartners.id), // nullable; set for corporate users only
```

### `folios` (extended)
```ts
// Credit authorization (US-CORP.3). true → scanner admits this 'booking' folio while unpaid AND the
// expiry sweep skips it (C8). Set automatically when the creator is a corporate user.
scanAllowedUnpaid: integer('scan_allowed_unpaid', { mode: 'boolean' }).notNull().default(false),
corporatePartnerId: text('corporate_partner_id').references(() => corporatePartners.id), // null for B2C
```
> `customer_phone`/`customer_email` reused for the partner contact on the credit folio.
> `commission_amount` stays `0` for corporate folios (C9). `booking_expires_at` stays **null** (C8).

### `folio_lines`
No new column — the existing per-line price field stores the **snapshotted net price** (US-CORP.6 AC4),
exactly as it already snapshots the unit price for B2C lines.

> **Deferred (NOT added):** a flat per-partner `discount_pct`; partner self-pay columns; statement/aging tables.

---

## 4. API surface

New router `src/routes/corporate/` (`authMiddleware` on all; per-route role). Money is integer
**minor units**. Per Multitenancy Rule 1, request bodies never carry `organization_id`/`status`/
`total`/prices. Corporate-facing routes are **caller-partner-scoped** (folio/partner must match the
caller's `corporate_partner_id`); admin-facing routes are **org-scoped**.

### 4.1 Corporate self-service (`requireRole('corporate')`)

| Method & path | Payload | Success | Errors | US |
|---|---|---|---|---|
| `GET /api/corporate/catalog` | `?date=…` | `200` services + availability + **partner net price** per service | — | CORP.1/6 |
| `POST /api/corporate/folios` | `{ lines:[…], customer_name?, down_payment? }` (`down_payment` 0..total, optional) | `201` (Folio + ready QRs) | `409 CREDIT_LIMIT_EXCEEDED`, `409 NO_CAPACITY_AVAILABLE`, `403 PARTNER_SUSPENDED`, `400 VALIDATION_ERROR` | CORP.2/6 |
| `GET /api/corporate/folios` | `?status=` | `200` partner's folios + `pending_balance`; header `outstanding`/`available` | — | CORP.2 (visibility C7) |

### 4.2 Admin — cobranza & settle (`requireRole('admin')`)

| Method & path | Payload | Success | Errors | US |
|---|---|---|---|---|
| `GET /api/corporate/debt` | `?partner_id=` | `200` org-wide credit folios + `partner_name`, `pending_balance`, `tour_date`, `past_event` | — | CORP.4 |
| `POST /api/pos/folios/:id/settle` *(extended)* | `{}` | `200` (Paid folio) | `409 ALREADY_SETTLED / FOLIO_CANCELLED`, `404`, `403` (corporate caller) | CORP.4 |

> **Settle reuse (C6):** the existing one-shot `settle` is extended so an **admin** may settle any
> in-org corporate credit folio (in addition to the existing agent self-settle of B2C bookings).
> When `scan_allowed_unpaid` is true the QRs already exist → settle **skips `finalizePaidFolio`**
> (QR-idempotent) and only flips status + writes `settled_at/by`. Commission top-up is a no-op
> (corporate `commission_amount=0`).

### 4.3 Admin — partner management (`requireRole('admin')`)

| Method & path | Payload | Success | Errors | US |
|---|---|---|---|---|
| `GET /api/corporate/partners` | — | `200` partners + derived `outstanding`/`available` | — | CORP.5 |
| `POST /api/corporate/partners` | `{ name, contact_email?, contact_phone?, credit_limit }` | `201` | `400` | CORP.5 |
| `PATCH /api/corporate/partners/:id` | `{ name?, contact_*?, credit_limit?, status? }` | `200` | `400`, `404` | CORP.5 |
| `PUT /api/corporate/partners/:id/rates` | `{ rates:[{ service_id, net_price }] }` (bulk upsert) | `200` | `400` (foreign service / negative), `404` | CORP.5 |
| `POST /api/corporate/partners/:id/users` | `{ name, email }` → invites a `corporate` user linked to the partner (reuses agent-invite) | `201` | `409` (email taken), `400` | CORP.5 |

### 4.4 Creation logic (handler, after server-computed `total`)

```
partner = load(caller.corporate_partner_id)                 // 404 if foreign/missing
if partner.status === 'suspended'         -> 403 PARTNER_SUSPENDED
total = Σ resolveCorporateUnitPrice(service, partner) × qty // = rate.net_price ?? service.public (snapshot per line)
dp = down_payment ?? 0
if dp < 0 || dp > total                    -> 400 VALIDATION_ERROR
folioDebt = total - dp
outstanding = Σ(total - amount_paid) over partner booking credit folios
if outstanding + folioDebt > partner.credit_limit  -> 409 CREDIT_LIMIT_EXCEEDED
atomic decrement inventory (+ compensation) -> else 409 NO_CAPACITY_AVAILABLE
persist: status = dp == total ? 'paid' : 'booking'
         scan_allowed_unpaid = true
         corporate_partner_id = partner.id
         amount_paid = dp ; commission_amount = 0 ; booking_expires_at = null
finalizePaidFolio(...)   // mint per-line QR + portal token + ticket email to partner contact
```

### 4.5 Scanner change (`tickets/handler.ts`, the only edit there)

```ts
// add scanAllowedUnpaid to the select; replace the status gate (line 98):
if (row.folioStatus === 'cancelled') return invalid(c, 'CANCELLED', ctx)
if (row.folioStatus !== 'paid' && !(row.folioStatus === 'booking' && row.scanAllowedUnpaid))
  return invalid(c, 'NOT_PAID', ctx)
// expiry + atomic redeem unchanged.
```

### 4.6 Sweep carve-out (C8)
Credit folios have `booking_expires_at = null`, so the existing `WHERE booking_expires_at <= now`
**already excludes them**. Add an explicit `AND scan_allowed_unpaid = 0` to the sweep query as
defence-in-depth so a credit folio can never be auto-cancelled.

---

## 5. UI/UX integration (functional minimalism)

Reduce cognitive load; reuse POS components with corporate context injected. Material Symbols,
elevation 0, the existing theme.

### 5.1 Corporate portal (`/corporate`, role `corporate`)
1. **Catalog** — the existing POS catalog/availability, prices swapped for the partner's **net
   prices**. No price editing, no discount toggles.
2. **Credit checkout** — a single, calm screen:
   - One amount input **"Anticipo (opcional)"** pre-loaded to **$0** (full credit is the norm).
   - A live helper line: **`Saldo a crédito $X · Crédito disponible $Y`**.
   - Primary CTA **"Confirmar reserva"**; it becomes disabled **"Excede tu crédito disponible"**
     when `folioDebt > available`. No min-deposit chip (the B2C floor doesn't apply).
3. **Confirmation** — "Tus boletos están listos" with the per-line QRs available to view/share
   immediately (they were minted at creation), plus the pending balance.
4. **"Mis reservas"** — the partner's folios, each showing pending balance, scan progress
   (redeemed/total), and status. **Read-only** re: settlement (the admin settles). A header chip
   shows **`Adeudo $… / Límite $…`** (own partner only — C7).

### 5.2 Admin — corporate management & cobranza (role `admin`)
1. **Socios Corporativos** — partner list with a **credit-usage bar** (`outstanding / credit_limit`).
   Create/edit drawer: name, contacts, credit limit, status toggle. A **Tarifas** tab: per-service
   net price inputs (blank = public price). An **Usuarios** tab: invite concierge logins.
2. **Cobranza** — the debt dashboard. Cards sorted **past-event first**, each with partner, pending
   balance, tour date, and an **orange "Evento pasado"** flag for aging. Filter by partner. The
   single action is **"Registrar pago y liquidar"** → confirm → one-shot settle → card clears and
   the partner's headroom updates.

No B2B/B2C switch in the agent POS — corporate flows live entirely in their own surfaces.

---

## 6. Scope boundary & cross-feature impact

| Concern | Owner |
|---|---|
| Corporate role, partner + rate tables, credit folio create, credit-limit check, debt dashboard, partner/rate/user admin, corporate portal | **This feature** |
| Cart prep, atomic decrement + compensation, QR signing, portal token, ticket email (`finalizePaidFolio`) | *POS / QR / Email* — reused, **invoked at creation** for credit folios |
| One-shot settle | *Bookings* — **extended** for admin-settle + QR-idempotency; B2C agent self-settle unchanged |
| Scanner "paid only" gate | *Scanner* — **narrowly relaxed** for `booking + scan_allowed_unpaid` (the only edit) |
| Expiry sweep | *Bookings* — credit folios excluded (null expiry + explicit guard) |
| **Cash drawer** | *Cash drawer* — **no impact**: corporate folios are not field-agent cash collections (self-service, electronic/credit); they never enter an agent's drawer. |
| Commissions | *Commissions* — corporate folios carry `commission_amount=0`; no running-balance effect |
| Self-signup, partner self-pay, statements/aging, flat discount % | **Deferred** (§1.2) |

---

## 7. Test scenarios (vitest is the API gate)

1. **Role & routing** — a `corporate` user reaches `/api/corporate/*`; hitting agent/admin routes → `403`.
2. **Credit booking happy** — total `$8,000`, `down_payment 0`, limit `$50k`, debt `$10k` → `201`,
   `status:booking`, `scan_allowed_unpaid:1`, inventory decremented, **QR minted**, `pending:8000`.
3. **Partial deposit** — `down_payment 3000` → `amount_paid:3000`, `pending:5000`, `booking`.
4. **Full payment via portal** — `down_payment == total` → `status:paid`, no debt, QR minted.
5. **Credit limit exceeded** — debt `$45k`, limit `$50k`, folio debt `$8k` → `409 CREDIT_LIMIT_EXCEEDED`,
   **inventory untouched**.
6. **Suspended partner** — `409`/`403 PARTNER_SUSPENDED`; existing folios still scannable.
7. **Negotiated price** — partner net `$450` vs public `$600`, qty 4 → line total `$1,800`, snapshotted.
8. **Price fallback** — service without override uses public price.
9. **Scanner exemption** — scan a credit `booking` folio with balance → `valid`, one pass redeemed.
10. **Exemption is flag-scoped** — a B2C `booking` (`scan_allowed_unpaid=0`) → `NOT_PAID`.
11. **Cancelled credit folio** — scan → `CANCELLED` (flag never overrides).
12. **Admin settle** — settle a credit folio → `200 paid`, `amount_paid=total`, `settled_at/by`,
    **no QR re-mint**, partner `available` increases by the prior pending.
13. **Settle guards** — paid→`409 ALREADY_SETTLED`; cancelled→`409 FOLIO_CANCELLED`; corporate caller→`403`; foreign→`404`.
14. **Debt dashboard** — lists credit folios, `past_event` true when earliest slot < today, sorted past-event first.
15. **Sweep carve-out** — a credit folio is **never** swept (null expiry + explicit guard); a B2C expired booking still is.
16. **Partner/rate admin** — create partner, bulk-upsert rates (foreign service → `400`), invite corporate user (dup email → `409`).
17. **Org isolation (`seedTwoOrgs`)** — Org A cannot read/settle Org B's corporate folios, partners, or rates (`404`); a corporate user of Partner X cannot read Partner Y's folios.
18. **Backward compat** — B2C POS confirm/scan/settle suites stay byte-identical green.

---

## 8. Definition of Done

- [ ] Additive migration: `corporate_partners`, `corporate_partner_rates`, `users.{role+'corporate',
      corporate_partner_id}`, `folios.{scan_allowed_unpaid, corporate_partner_id}`.
- [ ] `requireRole` + auth/`UserRole` accept `corporate`; portal routing role-gated client + API.
- [ ] `resolveCorporateUnitPrice` (net ?? public, snapshotted per line) + credit-limit (derived
      `outstanding`) check.
- [ ] `POST /api/corporate/folios` (deposit 0–partial, QR at creation via `finalizePaidFolio`,
      `scan_allowed_unpaid=true`, no expiry, commission 0).
- [ ] Scanner exemption (`booking + scan_allowed_unpaid`) — the single `tickets/handler.ts` edit.
- [ ] Sweep explicit `scan_allowed_unpaid=0` guard.
- [ ] Admin `settle` extended (admin-settle + QR-idempotent); corporate caller `403`.
- [ ] `GET /api/corporate/debt` (past-event aging + sort); partner/rate/user admin endpoints (range-validated).
- [ ] Frontend: corporate portal (catalog net prices + credit checkout + ready QRs + "Mis reservas"),
      admin Socios Corporativos (limit/rates/users) + Cobranza dashboard (settle).
- [ ] Tests: all §7 incl. **Sc.17 org isolation via `seedTwoOrgs`** and Sc.18 backward-compat; existing suites green.

---

## 9. Open decisions

| # | Question | Recommended default |
|---|---|---|
| O1 | **Down-payment payment method** for a corporate deposit (the optional upfront amount). | Treat as electronic/`transfer`; not in any agent cash drawer (corporate is self-service). |
| O2 | **Credit limit unit** — gross `total` debt vs net of deposits. | **Outstanding = Σ(total − amount_paid)** (net of deposits) — the real exposure. |
| O3 | **Ticket-email recipient** on a credit folio. | The **partner contact** (`corporate_partners.contact_email`), falling back to the folio `customer_email`. |
| O4 | **Partner self-pay online** from the portal. | **Deferred** (§1.2) — admin-only settle this phase (C6). |
| O5 | **Flat discount % vs per-service rates** as the partner default. | Per-service net rates this phase (C4); a flat-% shortcut is a later convenience. |
| O6 | **Aging threshold** styling in cobranza (e.g. >7d past event = red). | Binary `past_event` flag this phase; tunable aging buckets later. |
</content>
</invoke>
