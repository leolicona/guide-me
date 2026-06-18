# Bookings / Down-payments (Apartados) — Spec

**Feature:** Register a sale as an *apartado* (booking) with a partial amount received — reserve the spots now, collect the rest later, then settle into a fully-paid folio.
**Stories:** US-AG07.1 (cascade rules), US-AG07.2 (adaptive checkout), US-AG07.3 (CRM recovery), US-AG07.4 (manual cancel), US-AG07.5 (late arrival contingency), US-A46 (org policy).
**Status:** Updated Specification. SHOULD HAVE.
**Owner module:** `api-guideme/src/routes/pos/`, `organizations/`, `app-guideme/src/features/pos/`.

---

## 1. Context & Architecture

GuideMe allows agents to take a **deposit** for a service, **hold the spots immediately** (decrementing inventory at booking time to prevent overbooking), and **collect the balance later** to flip the folio to `paid` and deliver the scannable ticket QRs.

This specification unifies two workflows:
1. **B2C Individual Tourists:** Must pay a minimum deposit, cannot enter the tour while unpaid (scanner blocks access), and are subject to auto-expiry if they do not settle before the event.
2. **B2B Corporate Partners (Hoteles/Convenios):** Allowed to book with flexible deposits and scan/enter unpaid, with billing settled days after the event. **→ Deferred to a later B2B phase (see §1.2).**

---

## 1.1 Confirmed Decisions (2026-06-17)

| # | Topic | Decision |
|---|---|---|
| D1 | **Settlement** | **One-shot** — the balance is collected in a single *Liquidar saldo*; no installment ledger. `amount_paid` jumps straight to `total`. |
| D2 | **Checkout** | **Adaptive, amount-driven** (US-AG07.2). The input pre-loads the **total**; sale type / button / validity derive from the amount. **No `Pago total / Apartado` toggle.** |
| D3 | **Suggested chip** | Reuses the **org minimum %**; the chip renders **only when `booking_min_down_payment_pct > 0`** (when 0, no chip — the agent types freely). |
| D4 | **Booking phone** | **Required + dialable** for a booking (so WhatsApp recovery always works). Full/instant sales keep phone optional. |
| D5 | **Recovery dashboard visibility** | **Caller-scoped for agents** (own bookings); **admins see the whole org**. Two agents never share a booking, so the cross-agent collision in US-AG07.3 Sc.3 reduces to **agent ↔ admin**; the reminder flag records the last contact and dims the icon. |
| D6 | **Reminder sync** | **Persisted flag + pre-flight atomic claim** (no realtime infra). `POST /reminder` is an **atomic conditional claim** (`… WHERE reminder_status='none'`): the tap runs it **before** opening WhatsApp and opens **only if it won**; a loser gets `claimed:false` + who/when and a non-blocking *¿Reenviar?* (`?force=true` re-claims). The dashboard refetch keeps the list fresh but is **not** the collision guard — the server-side claim is. Replaces the earlier passive-refetch design (which only converged after a poll, leaving a double-send window). |
| D7 | **Deposit on cancel/expiry** | **Non-refundable, retained in the agent's cash drawer** (US-AG07.4). Same treatment for manual cancel and auto-expiry. **Resolves O1.** |
| D8 | **Commission** | **Percent on the amount collected**; **fixed only on reaching `paid`** (reserved by the commissions spec). A retained deposit keeps its percent commission. |
| D9 | **No new screens — integrate into existing flow** (revises the standalone surfaces in US-AG07.3/07.5) | "Less is more": apartado management has **no dedicated dashboard or route**. The **existing Ventas list** (`FolioHistoryPage`, which already has a *Reservas* filter) gains an **urgency accent + countdown + one-tap WhatsApp** on booking cards; the **existing folio detail** (`FolioHistoryDetailPage`, and the post-sale `FolioReceiptPage`) **dynamically** grows the **expiry banner + Liquidar/Cancelar/Reactivar**. Agents manage everything on screens they already know — no new navigation to learn. The banner/actions and WhatsApp claim are **shared components** (`BookingActions`, `ExpiredBookingBanner`, `BookingWhatsAppButton`) in a dedicated **`features/bookings`** module (with `bookingUrgency` + the action hooks) reused by every detail surface; both the `pos` and `folios` features depend on it one-way, neither imports the other (see plan § "Module boundary"). |
| D9-admin | **Same affordances on the admin org-wide surface** (D5) | The **admin `/folios`** list (`FoliosListPage`) and detail (`FolioDetailPage`) get the **identical** decorations (urgency, pending balance, WhatsApp, expiry banner, Liquidar/Reactivar) — reusing the same shared components. This required extending the admin serializers (`listFolios`, `readFolio`) with `booking_expires_at`/`pending_balance`/`customer_phone`/`reminder_status`/`reminder_sent_*`. On a **`booking`-status** folio the admin detail shows the **non-refundable** Liquidar/Cancelar (US-AG07.4) and **hides** the US-A21 refundable *Cancelar folio*; that refundable flow stays for `paid` folios. The booking-action mutations also invalidate the admin `['folios']` query key so the list/detail refetch. |

## 1.2 Scope of THIS implementation (phasing)

| In scope now | Deferred (later phase) |
|---|---|
| Org-level policy (min %, hold days, same-day buffer) + a **cascade-ready resolver** | **Per-service policy overrides** (US-AG07.1 cascade) — columns + catalog UI |
| Booking creation, one-shot settle, adaptive checkout, recovery dashboard, manual cancel, auto-expiry sweep | **B2B `scan_allowed_unpaid`** — scanner exemption + expiry carve-out + governance |
| **US-AG07.5 reactivation only** (*Reactivar y Liquidar* when capacity exists) | **US-AG07.5 reschedule** (transfer deposit to another slot) + **coupon/credit-note** |

The resolver `resolveBookingPolicy(service, org)` is **shaped for cascade** (`Service-override ?? Org-global`) but, this phase, reads **org globals only** — adding the overrides later is a one-line change. The `services.*Override` and `folios.scan_allowed_unpaid` columns are **NOT added** this phase (YAGNI — no live reader yet).

## 1.3 Builds on / reserved rules (honoured verbatim)

| Reserved by | Rule | Where |
|---|---|---|
| `commissions/service-based-commission.spec.md` (Data Model, rule 4) | Percent on **amount collected**; fixed only on **`paid`**. | D8, US-AG07 settle |
| `pos/pos-controlled-discount.spec.md` | Bookings own the partial `amount_paid` + `booking` status. | Data Model |
| `cash-drawer/cash-drawer.spec.md` | Drawer **reads** `amount_paid`/`status`. | §6 carve-out |
| `scanner/online-qr-scanner.spec.md` | Scanner **refuses any non-`paid` folio**. | No scannable QR until settled |
| `cancellation/total-folio-cancellation.spec.md` (US-A21) | Cancel re-increments `booked` (releases spots). | Manual cancel + sweep |

---

## 2. Detailed User Stories & Acceptance Criteria

### US-AG07.1 — Motor de Reglas en Cascada e Inventario (Backend)

> As a: System Core / Admin
> I want: The backend to resolve in descending hierarchy the minimum deposit percentage and hold windows
> To: Compute the exact release timestamp (`booking_expires_at`) protecting tour capacity.

#### Lógica de Priorización (Cascada / Override)
When a booking is created, policy parameters are resolved using:
$$\text{Regla Aplicada} = \text{Servicio (Override)} \,\,??\,\, \text{Organización (Global)}$$

#### Acceptance Criteria

* **AC1: Hierarchical Expiry Computation:**
  The expiration timestamp `booking_expires_at` is computed at creation:
  1. **Hold Duration:** `HoldDuration = (Service.bookingHoldHoursOverride ?? (Org.bookingHoldDays * 24)) * 3600` (seconds).
  2. **Tour Buffer:**
     * If the earliest slot in the cart occurs on the **same day** as the purchase (device-local date):
       `TourBuffer = Org.sameDayBufferMinutes * 60` (seconds).
     * Else:
       `TourBuffer = (Service.bookingHoldHoursOverride ?? 24) * 3600` (seconds before slot departure).
  3. **Result:** `bookingExpiresAt = min( createdAt + HoldDuration, slot.startDateTime - TourBuffer )`.
* **AC2: Deposit Minimum Enforced:**
  The server rejects bookings (`400 DOWN_PAYMENT_BELOW_MINIMUM`) where deposit `D` is:
  `D < ceil(Total * (Service.bookingMinDownPaymentPctOverride ?? Org.bookingMinDownPaymentPct) / 100)`.

#### Gherkin Scenarios

```gherkin
Escenario 1: Aplicación de regla por defecto de la organización
  Dado que la organización tiene configurado un mínimo de apartado de 30% y una liberación de 24 horas antes del tour
  Y el servicio "Tour Prismas Basálticos" no tiene ningún override de servicio configurado
  Cuando el agente cotiza este tour para una fecha futura
  Entonces el sistema sugiere un apartado del 30% y fija `booking_expires_at` exactamente 24 horas antes del inicio del tour.

Escenario 2: Priorización del override por servicio
  Dado que la organización tiene un mínimo de 30%, pero "Tour Prismas Extremo" tiene un override de 50% y un buffer de 48 horas
  Cuando el agente procesa una reserva para este tour
  Entonces el backend resuelve dinámicamente y aplica la política del servicio (50% de enganche y `booking_expires_at` a las 48 horas previas al tour).

Escenario 3: Activación de la regla de último minuto (Mismo Día)
  Dado que un turista reserva un tour que se ejecuta el mismo día de la venta
  Y la organización tiene un same_day_buffer_minutes de 15 minutos
  Cuando el backend evalúa la expiración de la reserva
  Entonces ignora la regla estándar de horas previas y fija `booking_expires_at` a los 15 minutos antes de la salida.
```

---

### US-AG07.2 — Interfaz de Checkout Adaptativa e Inteligente (UI/UX)

> As a: Field Sales Agent
> I want: A checkout screen that starts pre-loaded with the total and reacts fluidly to input or chips
> To: Finalize full payments in one tap or convert dynamically into booking mode.

#### Tabla de Estados de Interacción (UI)

| Monto Ingresado ($A$) | Condición | Tipo de Venta | Texto Botón Principal | Estado Botón | Estado Chip Sugerido |
|---|---|---|---|---|---|
| $A = \text{Total}$ | Happy Path | `FULL_PAYMENT` | "Finalizar Pago" | Habilitado | Inactivo (Apagado) |
| $A = \text{Sugerido}$ | Click en Chip | `PARTIAL_PAYMENT` | "Registrar Reserva" | Habilitado | Activo (Iluminado) |
| $\text{Mínimo} \le A < \text{Total}$ | Edición Manual | `PARTIAL_PAYMENT` | "Registrar Reserva" | Habilitado | Inactivo (Apagado) |
| $0 < A < \text{Mínimo}$ | Piso Violado | `INVALID` | "Monto Insuficiente" | Deshabilitado | Inactivo (Apagado) |
| $A > \text{Total}$ | Exceso | `INVALID` | "Excede el Total" | Deshabilitado | Inactivo (Apagado) |

#### Gherkin Scenarios

```gherkin
Escenario 1: Inicialización con happy path precargado
  Dado que el agente abre la pantalla de cobro para un carrito con total de $1,500.00
  Cuando la pantalla carga
  Entonces el input numérico se muestra precargado con $1,500.00 y el botón principal indica "Finalizar Pago" (Enabled).

Escenario 2: Conversión instantánea a modo Reserva vía Chip
  Dado que se renderiza el chip inteligente [ Reservar con 30% ($450.00) ]
  Cuando el agente presiona el chip
  Entonces el valor del input cambia a $450.00, el chip pasa a estado iluminado y el botón principal cambia a "Registrar Reserva".

Escenario 3: Edición manual del monto que rompe el estado del chip
  Dado que el input tiene el valor de $450.00 y el chip está activo/iluminado
  Cuando el agente escribe manualmente un monto alternativo de $500.00
  Entonces el botón principal se mantiene como "Registrar Reserva" (ya que $500 >= $450 mínimo) pero el chip de sugerencia se apaga automáticamente.
```

---

### US-AG07.3 — Tablero Proactivo de Recuperación de Ingresos (CRM)

> As a: Sales Agent / Ticket Booth Operator
> I want: My existing **Reservas** list surfaced with expiration urgency and a quick WhatsApp button
> To: Proactively contact tourists before releasing their spots, avoiding empty tour seats.

> **Implementation (D9): no dedicated dashboard.** This is delivered by **enhancing the existing
> Ventas list** (`FolioHistoryPage`) — which already filters by *Reservas* — rather than building
> a new screen. Booking cards get a left urgency accent (Orange `< 24h`, Grey safe), a *Vence en…*
> chip, the pending-balance figure, and the `BookingWhatsAppButton` (pre-flight atomic claim, D6).
> "La pestaña de Reservas" in the scenarios below = the *Reservas* filter on that list.

#### Gherkin Scenarios

```gherkin
Escenario 1: Visualización y ordenamiento prioritario
  Dado que el agente accede a la pestaña de "Reservas"
  Cuando el listado se renderiza
  Entonces las tarjetas de apartado se muestran ordenadas por orden de expiración (más próxima primero) mostrando en un badge el Saldo Pendiente y un borde de color lateral (Naranja: Expira en < 24h, Gris: Seguro).

Escenario 2: Gestión proactiva vía WhatsApp de un solo toque
  Dado que el agente selecciona la tarjeta de "Carlos Mendoza" (saldo pendiente: $1,050.00)
  Cuando presiona el botón rápido de WhatsApp
  Entonces abre la aplicación nativa de WhatsApp con un chat al número registrado, inyectando el texto pre-llenado:
  "Hola Carlos Mendoza, te escribe [Agente] de [Organización]. Te recordamos que tu reserva para el tour [Nombre del Tour] de hoy a las [Hora] expira pronto. Puedes liquidar tus $1,050.00 restantes directamente conmigo para asegurar tus lugares. ¡Te esperamos!"

Escenario 3: Prevención de colisiones operativas en taquilla
  Dado que el agente "Sofía" hace click en el botón rápido de WhatsApp de una reserva
  Cuando se dispara la acción en el cliente
  Entonces el backend actualiza en tiempo real su estado de seguimiento a `Reminder Sent` (Recordatorio Enviado) y muta la opacidad del icono de contacto para evitar que otro agente envíe el mismo mensaje.
```

---

### US-AG07.4 — Cancelación Manual y Liberación Inmediata de Spots

> As a: Ticket Booth Agent
> I want: To cancel a booking manually if the customer requests a cancellation before the deadline
> To: Release capacity immediately back into the pool for last-minute walk-ins.

#### Reglas de Negocio Contables
* **Retención de Anticipo (Non-refundable):** Al realizar una cancelación manual por desistimiento del cliente, el anticipo ya cobrado (`amount_paid`) **no es reembolsable** y se queda en el corte de caja del agente.
* **Extinción de Adeudo:** El estatus pasa a `CANCELLED`, y la deuda pendiente (`total - amount_paid`) se cancela contablemente para cerrar el folio.

#### Gherkin Scenarios

```gherkin
Escenario 1: Cancelación exitosa y liberación en tiempo real
  Dado que un turista desiste de asistir y el agente cancela manualmente
  Cuando el agente hace click en [ Cancelar y Liberar Spots ] y confirma en el modal de advertencia
  Entonces el folio cambia de estado a `CANCELLED`, los spots bloqueados regresan inmediatamente a disponibilidad (`slots.booked` decrementado) y la tarjeta se remueve del listado.
```

---

### US-AG07.5 — Gestión de Contingencias y Expiración Tardía ("Turista Impuntual")

> As a: Ticket Booth Agent
> I want: To reactivate expired bookings safely if the tourist arrives late and there is still capacity
> To: Avoid friction with late customers while preventing overbooking.

> **Implementation (D9): no contingency screen.** The expiry banner and `Reactivar y Liquidar`
> button are **dynamically incorporated into the existing folio detail** (`FolioHistoryDetailPage`
> / `FolioReceiptPage`) via the shared `ExpiredBookingBanner` + `BookingActions` components — the
> agent opens the same folio they already know and the contingency actions appear in context.

#### Flujo de Resolución de Conflictos
```
[Turista llega tarde y reserva expiró]
                │
                ▼
      ¿Existe cupo disponible? (capacidad_efectiva - booked >= cupos_reserva)
         ├── SÍ ──> [Habilitar botón "Reactivar y Liquidar"] ──> [Bloquea cupos de nuevo y abre checkout]
         │
         └── NO ──> [Deshabilitar reactivación directa] 
                        │
                        ├───> [Habilitar botón "Reagendar / Transferir Saldo"] (Mueve enganche a otro slot)
                        │
                        └───> [Habilitar botón "Generar Cupón"] (Emite nota de crédito por anticipo)
```

#### Gherkin Scenarios

```gherkin
Escenario 1: El turista llega tarde pero el tour aún tiene asientos libres
  Dado que la reserva expiró hace 5 minutos liberando sus 4 spots
  Y el tour tiene capacidad_disponible >= 4
  Cuando el agente abre el folio de la reserva expirada
  Entonces el sistema muestra un botón destacado de [ Reactivar y Liquidar ] para re-bloquear los asientos y cobrar el saldo restante.

Escenario 2: El turista llega tarde pero el tour ya se llenó (Sobreventa prevenida)
  Dado que la reserva expiró y los 4 spots liberados ya fueron vendidos a otros clientes (capacidad < 4)
  When el agente consulta el folio expirado
  Entonces el botón [ Reactivar y Liquidar ] se muestra deshabilitado indicando "Tour Lleno"
  Y el sistema ofrece como únicas acciones: [ Reagendar Tour ] (para transferir el saldo a otra fecha) y [ Generar Cupón ] (monto a favor).
```

---

## 3. Data Model changes

**Migration is additive only** (new nullable / default columns) — no table rebuild; existing
folios read back as non-bookings.

### `organizations` (active — this phase)
```ts
bookingMinDownPaymentPct: integer('booking_min_down_payment_pct').notNull().default(0),  // US-A46
bookingHoldDays: integer('booking_hold_days').notNull().default(7),                       // US-A46
// US-A47 — two SIGNED departure offsets (+ before / − after). salesCutoff closes new sales/booking
// creation on a departing slot; bookingGrace times the unsettled same-day auto-cancel (renamed
// from same_day_buffer_minutes). Migration 0033: add salesCutoff (default 0) + RENAME the buffer.
salesCutoffOffsetMinutes: integer('sales_cutoff_offset_minutes').notNull().default(0),    // US-A47
bookingGraceOffsetMinutes: integer('booking_grace_offset_minutes').notNull().default(15), // US-A47 (was same_day_buffer)
```

### `folios` (active — this phase)
```ts
// Apartado expiry — snapshot at creation, so a later policy change never retro-shifts a live
// booking. Computed by resolveBookingExpiry (§4): min(createdAt + holdDuration, slotStart − tourBuffer).
bookingExpiresAt: integer('booking_expires_at', { mode: 'timestamp' }),
settledAt: integer('settled_at', { mode: 'timestamp' }),               // one-shot settle audit
settledBy: text('settled_by').references(() => users.id),
reminderStatus: text('reminder_status', { enum: ['none', 'sent'] }).notNull().default('none'), // US-AG07.3
reminderSentAt: integer('reminder_sent_at', { mode: 'timestamp' }),
reminderSentBy: text('reminder_sent_by').references(() => users.id),    // who sent the last reminder (D5)
```

### `folio_lines` (active — this phase)
```ts
// Commission inputs snapshotted at SALE time, so settle can re-derive the full commission without
// re-reading the (possibly edited) service. Keeps commission immutable per the commissions spec's
// snapshot rule. percent → basis points of line_total; fixed → minor units per spot (× quantity).
commissionType: text('commission_type', { enum: ['percent', 'fixed'] }).notNull().default('percent'),
commissionValue: integer('commission_value').notNull().default(0),
```

> `customer_phone` is **already** a nullable column; no schema change. Booking mode makes it
> **required + dialable** at the handler level (D4) — full sales keep it optional.

### Deferred columns (NOT added this phase — YAGNI, no live reader)
```ts
// services — per-service policy override (US-AG07.1 cascade, later phase):
//   bookingMinDownPaymentPctOverride: integer(...)   // nullable
//   bookingHoldHoursOverride:         integer(...)   // nullable, hours
// folios — B2B unpaid scanning (later B2B phase):
//   scanAllowedUnpaid:                integer(..., { mode: 'boolean' }).notNull().default(false)
```

---

## 4. API Surface

All routes live under the existing `pos` router (`authMiddleware` + `requireRole('agent','admin')`,
**caller-scoped**: a folio must belong to the caller `agent_id`; admins additionally reach the
org-wide list via `/api/folios`). Money is integer **minor units**. Per Multitenancy Rule 1, no
`organization_id`/`status`/`total` in request bodies.

| Method & path | Payload | Success | Errors | US |
|---|---|---|---|---|
| `POST /api/pos/folios` *(extended)* | `{ …, down_payment?: number }` — present ⇒ **booking** mode; absent ⇒ unchanged full sale. | `201` (Folio) | `400 DOWN_PAYMENT_BELOW_MINIMUM`, `400 VALIDATION_ERROR` (≥ total / phone missing) | AG07, AG07.2 |
| `POST /api/pos/folios/:id/settle` *(new)* | `{}` | `200` (Paid Folio + QR) | `409 BOOKING_EXPIRED / ALREADY_SETTLED / FOLIO_CANCELLED`, `404` | AG07 |
| `POST /api/pos/folios/:id/cancel` *(new)* | `{ reason?: string }` | `200` (Cancelled Folio) | `409` (not a live booking), `404` | AG07.4 |
| `POST /api/pos/folios/:id/reminder` *(new)* | `{ force?: boolean }` — **atomic claim** (D6). Returns `{ claimed, reminder_sent_at, reminder_sent_by }` | `200` (claimed true/false) | `409` (not a booking), `404` | AG07.3 |
| `POST /api/pos/folios/:id/reactivate` *(new)* | `{}` — re-block freed spots **iff** effective capacity ≥ the booking's spots, then return to settle | `200` (re-booked, fresh `booking_expires_at`) | `409 NO_CAPACITY_AVAILABLE`, `404` | AG07.5 |
| `PUT /api/organizations/me` *(extended)* | `{ booking_min_down_payment_pct?, booking_hold_days?, sales_cutoff_offset_minutes?, booking_grace_offset_minutes? }` (offsets signed, ±240) | `200` | `400` (range) | A46/A47 |
| `POST /api/pos/folios` + `…/reactivate` *(guard, US-A47)* | — | — | `409 SLOT_CLOSED` when the slot's departure has passed `sales_cutoff_offset_minutes` (blocks selling/booking/reactivating a departed slot) | A47 |
| `GET /api/pos/folios?status=booking` *(row extended)* | — | row gains `booking_expires_at`, `pending_balance` (=`total−amount_paid`), `reminder_status` | — | AG07.3 |
| `GET /api/folios` + `GET /api/folios/:id` *(admin, extended — D5/D9-admin)* | — | list rows & detail gain `booking_expires_at`, `pending_balance`, `customer_phone`, `reminder_status`, `reminder_sent_at/by` so the org-wide `/folios` surface decorates apartado rows | — | AG07.3 |

### 4.1 Booking creation (handler logic, after `total` is computed)

```
// US-A47 — sales cutoff applies to EVERY line of EVERY new folio (full sale AND booking), per
// line in the validate loop, BEFORE any inventory decrement:
for (line of lines) if (slotEpoch(line) <= now + org.salesCutoffOffsetMinutes*60) -> 409 SLOT_CLOSED

policy = resolveBookingPolicy(service, org)          // = service-override ?? org-global; org-only this phase
if (down_payment != null) {
  require customer_phone is present & dialable         // D4 → 400 VALIDATION_ERROR otherwise
  if (down_payment >= total)            -> 400 VALIDATION_ERROR  ("full payment is not a booking")
  minRequired = ceil(total * policy.minDownPaymentPct / 100)
  if (down_payment < minRequired)       -> 400 DOWN_PAYMENT_BELOW_MINIMUM
  status='booking'; amountPaid=down_payment
  commission = round(fullPercentCommission * down_payment / total)   // fixed = 0 until paid (D8)
  bookingExpiresAt = resolveBookingExpiry(policy, createdAt, earliestSlotStart)   // §4.2
  SKIP QR/portal/ticket-email; SEND apartado-confirmation email instead.
} else { /* unchanged paid path: status='paid', amountPaid=total, full commission, QR/email */ }
```

### 4.2 Expiry resolver (org-level this phase; US-AG07.1 AC1 shape)

```
holdDuration = org.bookingHoldDays * 24 * 3600
tourBuffer   = sameDay(earliestSlot, createdAt)  ? org.bookingGraceOffsetMinutes * 60  : 24*3600
bookingExpiresAt = min( createdAt + holdDuration,  earliestSlotStart - tourBuffer )
// US-A47 — bookingGraceOffsetMinutes is SIGNED: a NEGATIVE grace makes tourBuffer negative, pushing
// the expiry PAST departure (a courtesy window for an unsettled same-day apartado).
```
*(Cascade-ready: the service-override branch is a later phase; the resolver signature already
takes `service` so wiring it in is additive.)*

### 4.3 Settle / Cancel / Reactivate effects

- **Settle** → `status='paid'`, `amount_paid=total`, `settled_at/by`, commission topped up to
  `fullPercent + fullFixed` (re-derived from the `folio_lines` **commission snapshot** — see §3 —
  attributed to the **original** `agent_id`). Mints per-line QR + portal token, sends the full
  ticket email. Inventory untouched. Guards: paid → `ALREADY_SETTLED`, cancelled → `FOLIO_CANCELLED`,
  `now > booking_expires_at` → `BOOKING_EXPIRED`.
- **Reminder (atomic claim, D6)** → conditional `UPDATE … SET reminder_status='sent',
  reminder_sent_at=now, reminder_sent_by=caller WHERE id=? AND organization_id=? AND
  reminder_status='none'`. 1 row ⇒ `{ claimed:true }` (caller opens WhatsApp). 0 rows ⇒
  `{ claimed:false, reminder_sent_at, reminder_sent_by }` (already contacted — UI offers
  *¿Reenviar?*). `force:true` re-claims unconditionally (refreshes `*_at/by`). Booking-only (else `409`).
- **Cancel** (manual, booking-only) → release spots (`slots.booked −= qty` per line), `status='cancelled'`,
  `cancelled_at/by`, `cancellation_reason`. **Deposit retained** (`refund_status='none'`); the
  agent keeps the percent commission on the deposit (D7/D8).
- **Reactivate** → only when `status='cancelled'` **and** it was a booking (`booking_expires_at`
  set) **and** effective capacity ≥ the booking's spots: re-decrement the slots, set
  `status='booking'`, fresh `booking_expires_at`, then the client proceeds to settle. Else
  `409 NO_CAPACITY_AVAILABLE` (UI offers the deferred Reagendar/Cupón).

### 4.4 Auto-expiry sweep (first scheduled Worker)

New Cloudflare **Cron Trigger** (`wrangler.jsonc` `"triggers": { "crons": ["*/15 * * * *"] }`) +
a `scheduled(event, env, ctx)` export beside the Hono `fetch` in `src/index.tsx` (repo's first).
Selects `status='booking' AND booking_expires_at <= now`; per folio (each write filtered by its
own `organization_id`): release spots, `status='cancelled'`, `cancellation_reason='Apartado vencido'`,
`cancelled_by=null` (system). **Deposit retained** (same as manual cancel). The settle guard is the
lazy backstop for an as-yet-unswept folio.

---

## 5. UI/UX Interaction States (Frontend)

Functional minimalism — reduce cognitive load, stay elegant. No B2B switch this phase.

1. **Adaptive checkout (fast-sale Bottom Sheet, US-AG07.2):**
   * **No toggle.** A single amount input **pre-loaded to the cart total**. Sale type, button
     label, and validity derive from the amount per the §2 *Estados de Interacción* table.
   * **Smart chip** `[ Reservar con X% ($Y) ]` (X = `booking_min_down_payment_pct`) — rendered
     **only when X > 0**. Tapping sets the input to $Y and lights the chip; a manual edit that
     leaves $Y dims the chip (render-phase derived state, no effect).
   * Phone field is **required** once the amount makes it a booking (D4); helper line shows
     `Saldo pendiente $… · Mínimo $…`.
2. **Recovery on the existing folio lists (CRM, US-AG07.3 — D9, no dedicated dashboard):**
   * Delivered by enhancing the agent `FolioHistoryPage` (caller-scoped) **and** the admin
     `FoliosListPage` (org-wide, D5) — both already filter by *Reservas*. **Only `booking`-status
     cards** are decorated; paid/cancelled cards read as before.
   * Left accent Orange if `expires_in < 24h`, Grey if safe; a *Vence en…* chip; the
     pending-balance figure beside Total/Anticipo.
   * **WhatsApp (pre-flight, D6)** via the shared `BookingWhatsAppButton`: tap → `POST /reminder`
     (atomic claim) **first** (the button `stopPropagation`s so it never opens the card's detail).
     On `claimed:true` → dim the icon to opacity 0.5 and `window.open("https://wa.me/{phone}?text=…")`
     with client-built copy. On `claimed:false` → a non-blocking *¿Reenviar?* confirm; on accept it
     re-posts with `force:true` then opens WhatsApp. The dim persists for other viewers after refetch.
   * Tapping the card opens the **existing folio detail** for the in-context actions (below).
3. **Expiry & settle on the existing folio detail (US-AG07/07.4/07.5 — D9):**
   * No separate screen: `ExpiredBookingBanner` + `BookingActions` are dropped into the agent
     `FolioHistoryDetailPage`, the post-sale `FolioReceiptPage`, **and the admin `FolioDetailPage`**
     (D5). QR access is gated to `paid`; a live/expired apartado shows a pending-balance row.
   * On the **admin** detail, a `booking`-status folio shows the non-refundable Liquidar/Cancelar
     and **hides** the US-A21 refundable *Cancelar folio* (which stays for `paid` folios).
   * **Live apartado** → **`[ Liquidar saldo ]`** (one-shot) + **`Cancelar apartado`** (confirm,
     non-refundable, releases spots).
   * **Expired apartado** → banner **"Apartado Expirado - Cupos Liberados"** + green
     **`[ Reactivar y Liquidar ]`**; if the tour has refilled the reactivate call returns
     `409 NO_CAPACITY_AVAILABLE` (inline error). `[ Reagendar ]` and `[ Generar cupón ]` render
     **disabled / "Próximamente"** — a **later phase** (§1.2).

---

## 6. Scope boundary & cross-feature impact

| Concern | Owner |
|---|---|
| Booking create / settle / cancel / reactivate / reminder, org policy, expiry sweep, adaptive checkout; apartado affordances **integrated into the existing Ventas list + folio detail** (D9, no dedicated dashboard) | **This feature** |
| Cart pricing, atomic decrement, controlled discount, extras, QR signing, ticket email, portal token | *POS / QR / Email* — reused (QR+email **invoked at settle**) |
| Commission snapshot storage + running-balance derivation | *Commissions* — this feature only sets the snapshot per D8 |
| **Cash drawer** | *Cash drawer* — **REQUIRES A FOLLOW-UP**: today it *excludes* `cancelled` folios from collected cash, but a **non-refundable retained deposit stays in the drawer** (D7). The drawer must count `amount_paid` of a `cancelled` **booking** (deposit retained) as collected cash — a "cancelled-but-retained" carve-out. Tracked as an Open Decision + a note to the cash-drawer owner. |
| Admin total cancellation **with refund** (US-A21) | *Cancellation* — unchanged; the new agent `/cancel` is **booking-only, non-refundable** and distinct |
| B2B unpaid scanning, per-service overrides, reschedule, coupon/credit-note | **Deferred** (§1.2) |

---

## 7. Test Scenarios (vitest is the API gate)

1. **Happy booking** — total `$1500`, deposit `$450` → `201`, `status:booking`, `amount_paid:450`,
   `pending_balance:1050`, spots decremented, apartado email, **no QR**.
2. **Phone required** — booking with no `customer_phone` → `400 VALIDATION_ERROR`; full sale without phone still `201`.
3. **Below minimum** — org min `30%`, total `$1500`, deposit `$300` → `400 DOWN_PAYMENT_BELOW_MINIMUM`; `$450` → `201`.
4. **Deposit ≥ total** → `400`.
5. **Expiry (not same-day)** — earliest slot in 5 days, hold 7d → `booking_expires_at = slotStart − 24h` (the earlier bound).
6. **Expiry (same-day)** — slot today, `same_day_buffer_minutes=15` → `booking_expires_at = slotStart − 15min`.
7. **Settle happy** — settle Sc.1 → `200`, `paid`, `amount_paid:1500`, QR minted + email, commission topped up.
8. **Commission** — `percent 10%`: `commission = round(150×450/1500)=45` at booking, `150` after settle; `fixed $50/spot`: `0` at booking, full at settle.
9. **Settle guards** — paid→`409 ALREADY_SETTLED`; cancelled→`409 FOLIO_CANCELLED`; foreign→`404`; expired→`409 BOOKING_EXPIRED`.
10. **Manual cancel** — `/cancel` on a booking → `200 cancelled`, spots released, `refund_status:none` (deposit retained), commission unchanged.
11. **Auto-expiry sweep** — past-expiry booking → swept to `cancelled` ('Apartado vencido'), spots freed, deposit retained.
12. **Reactivate (capacity)** — reactivate a swept booking when spots free → `200 booking`, spots re-decremented, fresh expiry.
13. **Reactivate (full)** — freed spots resold (effective capacity < booking spots) → `409 NO_CAPACITY_AVAILABLE`.
14. **Reminder claim** — first `/reminder` → `200 { claimed:true }`, `reminder_status:'sent'`,
    `reminder_sent_at/by` set.
14b. **Reminder collision** — a second `/reminder` (different caller) → `200 { claimed:false }` with
    the **first** caller's `reminder_sent_at/by` (the atomic `WHERE reminder_status='none'` let only
    one win). `force:true` re-claims → `{ claimed:true }`, `reminder_sent_by` updated.
15. **Admin policy** — set `min 50 / hold 3 / buffer 10`; **new** bookings use them, **existing** keep their snapshotted expiry.
16. **B4 — org isolation** — Org A cannot settle/cancel/remind/reactivate/read Org B's booking (`404`); the sweep's writes each filter by the folio's own `organization_id`. *(Uses `seedTwoOrgs`.)*
17. **Backward compat** — `POST /api/pos/folios` without `down_payment` is byte-identical to today (existing POS suite green).

---

## 8. Definition of Done

- [x] Additive migration (`0028_add_bookings_down_payments.sql`): `organizations.{booking_min_down_payment_pct,booking_hold_days,same_day_buffer_minutes}`, `folios.{booking_expires_at,settled_at,settled_by,reminder_status,reminder_sent_at,reminder_sent_by}`, `folio_lines.{commission_type,commission_value}`.
- [x] `resolveBookingPolicy` (cascade-ready, org-only) + `bookingExpiryDate` resolver (§4.2).
- [x] `confirmSale` booking mode (phone required, deposit bounds, percent-on-collected, expiry snapshot, deferred QR/email + apartado email); paid path unchanged.
- [x] `settle` / `cancel` / `reminder` (atomic claim) / `reactivate` endpoints with all guards (owner-or-admin scoped).
- [x] Org policy editable via `PUT /api/organizations/me` (range-validated, admin-only).
- [x] Scheduled Worker (`wrangler.jsonc` cron `*/15` + `scheduled` export → `sweepExpiredBookings`) sweeps expired bookings.
- [~] Cash-drawer carve-out for cancelled-but-retained deposits — **filed as a cross-feature follow-up** (`docs/TECH_DEBT.md` §17), owned by the cash-drawer derivation.
- [x] Frontend (D9 — **no new screens**): adaptive checkout (states + suggested chip); apartado recovery **integrated into the existing folio lists** — agent `FolioHistoryPage` and admin `FoliosListPage` (urgency accent + countdown + WhatsApp pre-flight/dim on `booking` cards); **expiry banner + Liquidar/Cancelar/Reactivar dynamically added to every folio detail** (`FolioHistoryDetailPage`, `FolioReceiptPage`, admin `FolioDetailPage`) via shared `BookingActions`/`ExpiredBookingBanner`/`BookingWhatsAppButton`; the admin detail hides the US-A21 refundable cancel for `booking` folios (D9-admin); admin serializers (`listFolios`/`readFolio`) extended with the booking fields; booking mutations invalidate the admin `['folios']` cache. Org policy editable on the admin **Configuración** screen (US-A46), which is what surfaces the deposit chip.
- [x] Tests (26 new): all §7 scenarios incl. **Sc.16 org isolation via `seedTwoOrgs`** and Sc.17 backward-compat; full suite 345 pass (the only 6 reds are a pre-existing, unrelated QR-ticket-expiry date-bomb in the scanner suite).

---

## 9. Open decisions

| # | Question | Recommended default |
|---|---|---|
| O1 | ~~Forfeited-deposit accounting~~ | **Resolved (D7)** — non-refundable, retained in the agent's drawer. |
| O2 | ~~Dashboard scope~~ | **Resolved (D5)** — caller-scoped agents + org-wide admin. |
| O3 | **Cash-drawer carve-out** for a cancelled-but-retained booking deposit (the agent holds that cash). | Count a `cancelled` **booking's** `amount_paid` as collected cash; coordinate with the cash-drawer owner. |
| O4 | **Launch policy values** (`min %`, `hold_days`, `same_day_buffer`). | `0% / 7d / 15min` defaults; product tunes per-org. |
| O5 | **Sweep cadence** | 15-min cron (snappier spot release for last-minute walk-ins). |
| O6 | **WhatsApp template** copy + i18n | Hardcoded ES template this phase; i18n with the bilingual feature (US-L0x). |
