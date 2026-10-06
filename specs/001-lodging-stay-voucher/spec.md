# Feature Specification: Lodging Stay Voucher

**Feature Branch**: `feat/lodging-stay-voucher`

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "Comprobante QR para hospedaje (lodging stay voucher). Hoy una estancia (línea `stay`) no recibe QR: `signLineTickets` solo firma líneas de tour con slot, así que el cliente de hospedaje no tiene comprobante, el correo de confirmación de una venta solo-hospedaje llega sin la estancia, y el portal no muestra nada que presentar en recepción. Queremos: (1) firmar un QR por línea de estancia en cada punto donde hoy se emiten QR de tour — venta pagada, liquidación de apartado (total y por línea) y verificación de transferencia — con vigencia hasta la fecha de salida; (2) que recepción lo escanee con el escáner existente al hacer check-in; (3) que el correo de confirmación, la página pública del boleto (/t/), el portal del turista y la pantalla de resultado del escáner muestren la estancia (entrada–salida, huéspedes, habitaciones, tipo de unidad) en vez de fecha/hora/personas de tour; (4) que el correo de apartado muestre bien una estancia (entrada y salida, huéspedes en vez de habitaciones, y la hora de vencimiento en la zona horaria de la organización); (5) que el reloj del apartado de una estancia se ancle a la hora de check-in del tipo de unidad (`checkin_time`, default 15:00) y no a las 00:00 del día de entrada, porque hoy un apartado hecho el día anterior se autocancela a las 23:45 de la noche previa a la llegada. Decisiones abiertas: cuántos escaneos consume una estancia, si se rechaza un escaneo antes de la fecha de entrada, y si las plantillas de WhatsApp necesitan un texto propio para hospedaje."

## What is broken today *(context — constitution I)*

Measured against `develop@7e699fa`, from a real sale in August 2026: a cabin for 5 guests, sold on
2026-08-13 ~14:20 for check-in 2026-08-14, deposit taken, balance *"a su llegada"*.

| # | Today | Number |
|---|---|---|
| B1 | A stay line never receives a QR. The four places that issue QRs (paid sale, settle, settle one line, verified transfer) all keep only tour lines. | **0 of 4** issuing points cover stays; **0%** of stay lines carry a voucher |
| B2 | The confirmation email of a stays-only sale lists only lines that have a QR. | **0** stays listed; the guest gets a total and a link, no dates |
| B3 | The apartado email renders a stay as a tour: check-in date followed by an empty time, and *"Personas"* showing **rooms**. | 5 guests in 1 room reads *"Personas: 1"* |
| B4 | The apartado email prints the expiry hour in UTC, not the organization's time zone. | **6 h** off for `America/Mexico_City` (an expiry at 23:45 reads *05:45 del día siguiente*) |
| B5 | A stay's hold is measured from **00:00** of the check-in day. Sold less than a day ahead, it releases at 23:45 the night **before** arrival. | Hold lived **~9 h 25 min**; it ended **~15 h** before the 15:00 check-in the guest was told to pay at |
| B6 | Even with a working link, the guest's portal had nothing to present at the front desk. | **0** scannable items for a stays-only sale |

The scanner, the portal, the public ticket page and the WhatsApp delivery already exist and work
for tours. This feature extends them to stays; it does not rebuild them.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The guest receives a stay voucher once the stay is paid (Priority: P1)

When a sale containing a stay is fully paid — sold paid, an apartado settled (whole or by line), or
a bank transfer verified — the guest receives, for each stay, a voucher they can show at the front
desk: a QR plus the stay's details (property / unit type, check-in and check-out dates, guests,
rooms). It is reachable from the same places as a tour ticket: the confirmation email, the
tourist portal, the public ticket page the QR opens, and the WhatsApp delivery link.

**Why this priority**: it is the product gap itself (B1, B2, B6). Without it the other stories have
nothing to scan or show.

**Independent Test**: sell a paid stay; the sale shows one voucher per stay line, the portal and the
public ticket page render it with the stay's dates and guests, and the confirmation email lists it.

**Acceptance Scenarios**:

1. **Given** a stay sold fully paid in cash, **When** the sale completes, **Then** the stay line has a voucher and the confirmation email lists the stay with check-in, check-out, guests, rooms and its QR.
2. **Given** a stay apartado, **When** the balance is settled (the whole sale, or that line alone), **Then** the stay line gets its voucher at that moment and not before.
3. **Given** a stay paid by bank transfer, **When** the payment is still unverified, **Then** no voucher exists; **When** an admin verifies it, **Then** the voucher is issued.
4. **Given** a sale with one tour line and one stay line, paid, **When** it completes, **Then** each line has its own voucher and the tour's ticket is unchanged from today.
5. **Given** a stay apartado still unpaid, **When** the guest opens the portal, **Then** no voucher is shown, only the pending balance (unchanged behaviour for unpaid sales).

---

### User Story 2 - The front desk validates the voucher at check-in (Priority: P1)

Staff scan the guest's voucher with the existing scanner. The result names the stay — unit type,
check-in and check-out dates, guests, rooms, guest name — and says whether to admit. A voucher
for a cancelled, unpaid, superseded, forged, other-organization or expired stay is refused exactly
as a tour ticket is today.

**Why this priority**: a voucher nobody can validate is a picture. This closes the loop the guest
was promised (*"presenta tu QR"*).

**Independent Test**: scan a paid stay's voucher on its check-in date → admitted with the stay's
details; scan it again → reported as already used (per Q1); scan it after cancellation → refused.

**Acceptance Scenarios**:

1. **Given** a paid stay checking in today, **When** staff scan its voucher, **Then** the scanner admits it and shows unit type, dates, guests, rooms and guest name.
2. **Given** that voucher already scanned, **When** it is scanned again, **Then** the result follows the scan rule decided in Q1.
3. **Given** a paid stay whose check-in date is tomorrow, **When** its voucher is scanned today, **Then** it is refused as *not yet valid* (`STAY_NOT_STARTED`) and nothing is consumed.
4. **Given** a stay line cancelled after its voucher was issued, **When** the voucher is scanned, **Then** it is refused as cancelled.
5. **Given** a voucher from another organization, **When** it is scanned, **Then** it reads as invalid and reveals nothing about that organization.
6. **Given** a stay whose check-out date has passed (beyond the same post-date grace tours have), **When** it is scanned, **Then** it is refused as expired.

---

### User Story 3 - An unpaid stay apartado is still held when the guest arrives (Priority: P2)

A stay apartado's clock runs against the unit type's **check-in time** frozen at the sale (default
15:00), not against midnight. The "settle by" notice and the automatic release are computed from
that instant, so a guest told to pay *"a su llegada"* still has a reservation when they arrive
[NEEDS CLARIFICATION: Q2 — when exactly an unpaid stay apartado is released].

**Why this priority**: B5 is the failure that turns a missing link into a lost room. It ranks below
the voucher only because the voucher is what every paid stay needs, while this affects the subset
sold as apartados.

**Independent Test**: create a stay apartado the day before arrival; at 23:45 that night it is still
held; it releases only at the instant decided in Q2.

**Acceptance Scenarios**:

1. **Given** a unit type with check-in 15:00 and an apartado sold the day before arrival, **When** the night before arrival passes, **Then** the apartado is still held.
2. **Given** that apartado, **When** the release instant decided in Q2 passes unpaid, **Then** it is cancelled through the organization's cancellation policy, as apartados are today, and the rooms return to inventory.
3. **Given** an apartado sold, **When** the unit type's check-in time is later edited, **Then** the live apartado keeps the clock it was sold with (a sale freezes its terms).
4. **Given** a sale that also contains a tour line, **When** the stay's clock is re-anchored, **Then** the tour line's clock is unchanged (each line keeps its own clock).
5. **Given** a stay apartado opened too close to its check-in instant for the organization's creation cutoff, **When** the seller tries to create it, **Then** it is refused as today (`BOOKING_TOO_LATE`), measured against the check-in time instead of midnight.

---

### User Story 4 - Messages describe a stay as a stay (Priority: P3)

Every message about a sale that contains a stay — the apartado email, the confirmation email and the
WhatsApp messages — names the stay in lodging terms: check-in and check-out dates, guests (and rooms
when more than one), no departure time, no *"Personas"* counting rooms. Every instant shown to the
guest (an apartado's expiry or release) is in the organization's time zone.

**Why this priority**: B3/B4 mislead but do not lose the room; the voucher and the hold come first.

**Independent Test**: create a stay apartado with 5 guests in 1 room for 2026-08-14 → 2026-08-15; the
apartado email reads *"Entrada 14 ago · Salida 15 ago · 5 huéspedes"* and its expiry hour matches the
organization's clock.

**Acceptance Scenarios**:

1. **Given** a stay apartado with 5 guests in 1 room, **When** the apartado email is sent, **Then** it shows check-in and check-out dates and *"5 huéspedes"*, with no empty time and no *"Personas: 1"*.
2. **Given** an organization in `America/Mexico_City`, **When** an apartado email shows its expiry, **Then** the hour is the organization's local hour (tours included — B4 affects every apartado email).
3. **Given** a stay sold, **When** the WhatsApp delivery message is composed, **Then** its wording follows the decision in Q3.

---

### Edge Cases

- **Stays sold before this feature ships** keep no voucher; their pages and messages render the stay details without a QR (no backfill).
- **A partially settled sale** (one line settled, another still an apartado): only the settled stay line has a voucher.
- **Multi-room line** (2 rooms of one type on one line): one voucher for the line; its scan behaviour follows Q1.
- **A stay voucher scanned on a day between check-in and check-out** (a late arrival): admitted, since the stay is in progress.
- **A stay line cancelled by line cancellation** while sibling lines stay live: only that line's voucher is refused.
- **The portal token or the voucher signature fails to issue** (best-effort, as today): the sale stands; the voucher can be reissued by the same paths that reissue tour tickets today.
- **A stays-only sale delivered by WhatsApp** where the organization's custom ticket text speaks of *"taquilla"* and *"evento"* — see Q3.
- **Unit types with no explicit check-in time** use the stored default (15:00).

## Requirements *(mandatory)*

### Functional Requirements

**Voucher issuance (US1)**

- **FR-001**: The system MUST issue one signed voucher per live stay line at each point where a tour line's ticket is issued today: a sale completed fully paid, an apartado settled (whole sale or single line), and a bank transfer verified on a fully paid sale.
- **FR-002**: The system MUST NOT issue a stay voucher while the line is unpaid (apartado) or its payment is unverified.
- **FR-003**: A stay voucher MUST be signed and validated by the server exactly as tour tickets are (per-organization key), and MUST carry what the scanner needs to identify the stay line without trusting the client.
- **FR-004**: A stay voucher MUST stop validating after the stay's check-out date, with the same post-date grace tour tickets receive after their departure date.
- **FR-005**: The confirmation email, the tourist portal and the public ticket page MUST show each stay with its voucher and its details: unit type name, check-in and check-out dates, guests, and rooms when more than one.

**Front-desk validation (US2)**

- **FR-006**: The existing scanner MUST validate stay vouchers, and its result MUST show unit type, check-in and check-out dates, guests, rooms and the guest's name.
- **FR-007**: A stay voucher scanned before its check-in date MUST be refused with the result code `STAY_NOT_STARTED` and MUST consume nothing.
- **FR-008**: A stay voucher MUST be refused for the same reasons a tour ticket is today (cancelled sale or line, unpaid, superseded, forged or foreign, expired), with the same result codes.
- **FR-009**: Scanning a valid stay voucher MUST consume passes according to [NEEDS CLARIFICATION: Q1 — one scan for the whole stay line, one per room, or none (validate only)?].

**Apartado clock for stays (US3)**

- **FR-010**: For a stay line, every apartado instant — the "settle by" deadline, the release, and the creation cutoff check — MUST be measured from the check-in date **at the unit type's check-in time**, not from 00:00.
- **FR-011**: The check-in time used for a sold line MUST be the one in force at the sale, frozen with it; later edits to the unit type MUST NOT move a live apartado.
- **FR-012**: An unpaid stay apartado MUST be released at [NEEDS CLARIFICATION: Q2 — the check-in time minus the organization's grace offset (as tours), the end of the check-in day, or a new lodging late-arrival window?], through the organization's cancellation policy exactly as apartados are released today.
- **FR-013**: Tour lines' apartado clocks MUST be unchanged.

**Messages (US4)**

- **FR-014**: The apartado email MUST render a stay with check-in and check-out dates and guests (rooms when more than one), with no departure time and no rooms shown as *"Personas"*.
- **FR-015**: Every date-time shown in a customer email (an apartado's expiry, a release notice) MUST be expressed in the organization's time zone.
- **FR-016**: WhatsApp messages for sales containing stays MUST follow [NEEDS CLARIFICATION: Q3 — keep the single editable ticket template, add a second editable template for lodging, or use a fixed lodging wording for stays-only sales?].

### Scope Boundary *(mechanical test — constitution I)*

These suites MUST pass **unedited** (tours, scanner, apartados, cancellation, delivery):

- `api-turistear/test/tickets/online-qr-scanner.test.ts`
- `api-turistear/test/tickets/group-redemption.test.ts`
- `api-turistear/test/qr/folio-qr-signing.test.ts` and `api-turistear/test/qr/qr.unit.test.ts`
- `api-turistear/test/pos/pos-bookings-create.test.ts`, `pos-bookings-settle.test.ts`, `pos-bookings-sweep.test.ts`, `pos-bookings-cancel.test.ts`, `pos-bookings-reschedule.test.ts`
- `api-turistear/test/folios/line-settle.test.ts`
- `api-turistear/test/cancellation/cancellation-policy-engine.test.ts` — the refund ladder keeps check-in 00:00 as a stay's departure; this feature does not re-price cancellations.
- `api-turistear/test/email/client-ticket-delivery.test.ts`
- `api-turistear/test/portal/ticket-page.test.ts` and `api-turistear/test/portal/tourist-self-service-portal.test.ts`
- `api-turistear/test/pos/whatsapp-delivery.test.ts`
- `app-turistear/src/features/pos/delivery.test.ts`

The **only** expected edits to existing tests are the two assertions that pin today's gap, in
`api-turistear/test/lodging/accommodation-stays.test.ts` (*"a stay has no per-line QR"*, *"a stay has
no scannable QR"*), which this feature deliberately reverses. New behaviour is proven in new test files.

Out of scope: rescheduling stays (still refused, `NOT_RESCHEDULABLE`), physical room assignment,
re-pricing stay cancellations, Express sales (cannot sell lodging), backfilling vouchers for stays
sold before release.

### Key Entities *(include if feature involves data)*

- **Stay line**: one sold line of `quantity` rooms of a unit type for nights [check-in, check-out), with total guests and the unit type's name frozen at sale. Gains the **check-in time frozen at sale** (FR-011) and, once paid, a **voucher**.
- **Stay voucher**: the signed, scannable proof that a paid stay line exists — one per stay line, valid from the check-in date through the check-out date (+ grace), consumed per Q1.
- **Apartado hold (stay)**: the deadline and release instant of an unpaid stay line, computed from its frozen check-in instant (FR-010, FR-012).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of stay lines in sales fully paid after release carry a voucher (today 0%, B1).
- **SC-002**: Front-desk staff validate a stay voucher with **one** scan and see dates, guests and rooms on the result, with no lookup by name.
- **SC-003**: A stay apartado sold the day before arrival is still held through the night before check-in (today released ~15 h before a 15:00 check-in, B5).
- **SC-004**: 100% of confirmation emails for sales containing stays list every stay with its dates (today 0 for stays-only sales, B2).
- **SC-005**: The expiry hour in apartado emails matches the organization's local clock — 0 h offset (today 6 h for `America/Mexico_City`, B4).
- **SC-006**: Every suite named in Scope Boundary passes unedited; tour sales, tickets and apartados behave exactly as before.

## Assumptions

- Front-desk staff validate with the existing in-app scanner under an organization account (agent or admin); no new role or device is introduced.
- The voucher reuses the tour ticket's presentation surfaces (portal, public page, email); "voucher" and "ticket" differ only in the details shown.
- The post-date grace for a stay voucher equals the one tours get after their departure date today.
- The cancellation refund ladder keeps check-in 00:00 as a stay's departure; only the apartado clock moves (US3). At any release instant on or after the check-in day the ladder is already in its terminal tier, so the release keeps today's retention outcome.
- The creation cutoff and the hold deadline keep their current organization settings; only the instant they are measured from changes for stays.
- Vouchers are not backfilled for stays sold before release.
- Copy follows es-MX product language (constitution VII): **Venta**, never "folio", in the UI.
