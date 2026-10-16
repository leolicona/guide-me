# Feature Specification: Transfer Verification Deadline

**Feature Branch**: `claude/explica-el-f-mppdyx`

**Created**: 2026-10-16

**Status**: Draft

**Input**: User description: "Límite de tiempo para verificar una transferencia (camino manual, sin
Devolada). Hoy una venta registrada como Transferencia espera en «Por verificar» sin límite: sus
lugares quedan apartados hasta que un admin la verifique o la rechace, aunque la salida ya haya
pasado; una liquidación de apartado por transferencia hace que el folio cuente como pagado, así que
el barrido de apartados deja de revisarlo. Producción (spec 006): de 5 transferencias, 1 de $900
sigue «pendiente» 66 días después. Queremos un límite configurable por organización en Ajustes, por
defecto 24 horas, contado desde que se registró el pago por transferencia. Al vencer, el sistema
actúa solo (decisión del dueño del producto, 2026-10-16): (a) venta completa o anticipo de apartado
→ se cancela como un «Rechazar» del admin (lugares liberados, comisión revertida), actor «Sistema»,
motivo «No se verificó la transferencia a tiempo»; (b) liquidación de apartado → se anula solo ese
pago y el folio vuelve a ser apartado con su anticipo, sus lugares y su propio plazo intactos (nunca
se cancela una venta que tiene dinero ya confirmado) — depende del arreglo
.specify/bugs/reject-settle-voids-deposit. Se avisa al cliente y al vendedor. Organizaciones que
conecten Devolada (spec 006) usan los plazos de su enlace; este límite cubre el camino manual."

## Context *(constitution I — what is broken, with numbers)*

Today a payment recorded as **Transferencia** waits in **Por verificar** until an admin taps
Verificar or Rechazar. Nothing bounds that wait (archived
`docs/payment-verification/payment-verification.spec.md`: US-AG41, US-A67, US-A88), and the seats
stay held the whole time:

| What is pending | What holds the seats today | Released without an admin? |
|---|---|---|
| A full sale | The sale itself | **Never** |
| An apartado's deposit | The apartado | Only when the apartado's own hold clock runs out |
| An apartado's settlement | The sale, which now counts as paid | **Never** — the apartado sweep stops looking at it, even after departure |

Production, read 2026-10-05 (spec 006, aggregates only): of 5 transfers since 2026-07-23, **1
($900, a same-day departure) was never verified and still read *pending* 66 days later**. No person
and no part of the system ever learned whether that money arrived.

Spec 006 bounds this wait to at most 24 hours, but only for an organization that connects
Devolada, and only for payments that get a Devolada link. Every organization today, and a connected
organization's fallback payments (006 FR-010), stay on the manual path this feature covers.

**Depends on** the lite-path fix `.specify/bugs/reject-settle-voids-deposit`. Today the only way to
withdraw a pending transfer cancels the whole sale, a cash deposit included. Outcome (b) below needs
a payment to be withdrawn without cancelling a sale that still holds confirmed money. That fix ships
first.

**Scope boundary (mechanical):** a transfer that an admin verifies or rejects before its deadline
behaves exactly as today. These suites MUST pass unedited:
`api-turistear/test/pos/payment-verification.test.ts`,
`api-turistear/test/pos/optional-payment-reference.test.ts`,
`api-turistear/test/paid-ledger/settle-method.test.ts` and
`api-turistear/test/pos/pos-bookings-sweep.test.ts`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An unverified sale gives its seats back on its own (Priority: P1)

A seller records a full sale, or an apartado's deposit, as Transferencia. Nobody verifies or rejects
it before the organization's limit (24 hours by default). The system then cancels the sale the way
an admin's Rechazar does: the seats go back on sale and the seller's commission is reversed. The
system («Sistema») is recorded as the actor, with the reason «No se verificó la transferencia a
tiempo». The customer is told, and the seller sees what happened on the sale.

**Why this priority**: this is the seat leak the production numbers show. A sale that nobody
verifies holds inventory forever and leaves a payment nobody ever resolves.

**Independent Test**: in an organization with the default limit, record a full sale by
Transferencia. Move the clock past the deadline and let the scheduled job run. The sale is
cancelled by «Sistema» with the reason, its seats are released, its commission is reversed, it
leaves Por verificar, and the customer message is queued.

**Acceptance Scenarios**:

1. **Given** a full sale paid by transfer and still awaiting verification, **When** its deadline
   passes with no Verificar or Rechazar, **Then** within 15 minutes the sale is cancelled as
   Rechazar cancels it: seats released, the seller's commission reversed, nothing refunded (no money
   was ever confirmed). «Sistema» is the actor, «No se verificó la transferencia a tiempo» is the
   reason, and the sale is no longer in Por verificar.
2. **Given** an apartado whose deposit was paid by transfer and is still awaiting verification,
   **When** its deadline passes first, **Then** the apartado is cancelled the same way.
3. **Given** a pending transfer, **When** an admin verifies it before its deadline, **Then**
   everything happens as today, and the deadline no longer applies to it.
4. **Given** a pending transfer, **When** an admin rejects it before its deadline, **Then**
   Rechazar applies as today (as corrected by `reject-settle-voids-deposit`), and the deadline no
   longer applies to it.
5. **Given** a sale cancelled by its deadline, **When** an admin then tries to verify it, **Then**
   the verification is refused and the admin is told the sale was already resolved.
6. **Given** two organizations with different limits, **When** a deadline passes in organization A,
   **Then** only organization A's sale changes, and organization B's setting never moves A's
   deadline (constitution III, proven with `seedTwoOrgs`).

---

### User Story 2 - An unverified settlement returns the sale to an apartado, never cancels it (Priority: P1)

An apartado whose deposit was confirmed (cash, or a verified transfer) is settled by transfer, and
nobody verifies the settlement before its deadline. The system withdraws that payment only. The
sale is an apartado again: it owes its balance, and keeps its seats, its deposit, the commission
the deposit earned and its own hold deadline. No tickets are released. A sale that holds confirmed
money is never cancelled by this limit.

**Why this priority**: this is the case with no exit today. The sale counts as paid, so the
apartado rules never revisit it, and the seats stay held after the departure. Cancelling it
instead would erase a deposit the seller physically holds, the defect `reject-settle-voids-deposit`
removes. It ships after that fix.

**Independent Test**: create an apartado with a cash deposit, settle it by transfer, move the clock
past the settlement's deadline and let the scheduled job run. The sale is an apartado again owing
its balance, its seats are still held, the seller's cash balance still includes the deposit, and
no tickets exist.

**Acceptance Scenarios**:

1. **Given** an apartado with a cash deposit whose balance was settled by transfer and is still
   awaiting verification, **When** the settlement's deadline passes, **Then** within 15 minutes
   only that payment is withdrawn:
   - the sale reads as an apartado owing its balance;
   - its seats stay held;
   - the deposit stays in the books and in the seller's cash balance;
   - the commission returns to what the deposit earned;
   - no tickets are released;
   - the timeline shows «Sistema» and the reason.
2. **Given** that returned apartado with its hold deadline still ahead, **When** the seller settles
   it again (in cash, or by a new transfer that starts its own deadline), **Then** the settlement
   works as any other.
3. **Given** a returned apartado whose own hold deadline has already passed, **When** the apartado
   rules next run, **Then** it is released by those rules — the cancellation policy, credit never
   cash — and the customer is told once.
4. **Given** a two-service apartado where service A was settled in cash (tickets issued) and
   service B by transfer, **When** B's settlement passes its deadline, **Then** service A is
   untouched (paid, tickets valid) and only service B owes again.
5. **Given** an apartado whose deposit **and** settlement are both unverified transfers, **When**
   the deposit's deadline passes, **Then** the sale holds no confirmed money and is cancelled as in
   Story 1, both payments included.

---

### User Story 3 - The admin sets the limit and sees the time left (Priority: P2)

In Ajustes, an admin sets **Plazo para verificar transferencias** in hours. Por verificar shows
how much time each payment has left, with the closest deadlines first, and the seller sees the same
on the sale.

**Why this priority**: the default already protects every organization. The setting lets an
operation with a slower or faster bank routine tune it, and the countdown lets the admin act before
the system does.

**Independent Test**: as an admin, change the limit to 6 hours, record a new transfer sale, and see
its deadline 6 hours after recording in Por verificar. Then record one with the previous setting
still pending and see that its deadline did not move.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they set the limit to any whole number of hours from 1 to 168,
   **Then** it is saved, and every transfer recorded afterwards gets that deadline.
2. **Given** a value outside 1–168 or not a whole number, **When** the admin saves, **Then** it is
   refused with a message saying the allowed range.
3. **Given** a transfer already pending, **When** the admin changes the limit, **Then** that
   payment's deadline does not move.
4. **Given** an agent, **When** they open Ajustes or call the setting directly, **Then** they
   cannot change the limit.
5. **Given** pending transfers, **When** the admin opens Por verificar, **Then** each shows its time
   left, the closest deadlines come first, and those with less than 2 hours left are marked, paired
   with an icon (constitution VII).

---

### Edge Cases

- **Verify and deadline at the same moment** → exactly one wins. A verified payment is never
  withdrawn, and a withdrawn payment is never verified afterwards.
- **The money arrives after the payment was withdrawn** → the admin returns it, or applies it to a
  new sale, outside the system, as 006 does for *unapplied* money. The sale's timeline shows when
  and why the payment was withdrawn.
- **A sale cancelled for another reason while its transfer is pending** (an admin cancellation, a
  service cancellation, the apartado's own clock) → when the deadline passes, the payment is
  resolved as not verified, with no further effect on money or seats, so no payment reads *pending*
  forever (the 66-day case).
- **An apartado whose own clock releases it while its deposit is still unverified** → the apartado
  rules apply. Credit is computed only from confirmed money: an unverified deposit never becomes
  credit.
- **The departure passes before the deadline** → the deadline does not move. A departed seat has no
  buyer, and the admin keeps the time to check the bank. No tickets exist until the money is
  verified, as today.
- **An admin sells by transfer** → the same deadline applies. Who may verify is unchanged.
- **A connected organization's fallback payment** (006 FR-010: no link could be created) → follows
  this deadline. A payment followed by a Devolada link follows 006.
- **Payments already pending when this ships** → their deadline counts from the release. Admins get
  a full window to review them; nothing is cancelled on deploy.

## Requirements *(mandatory)*

### Functional Requirements

**The setting**

- **FR-001**: Each organization MUST have a transfer verification limit, in whole hours from 1 to
  168, defaulting to 24. Only an admin can change it, in Ajustes. There is no "off" value.
- **FR-002**: The limit MUST apply to every electronic payment that awaits a person's verification:
  a full sale, an apartado deposit, and a settlement, whether of the whole sale or of one service.
  This includes a Devolada-connected organization's fallback payments. Payments followed by a
  Devolada link are governed by spec 006 instead.
- **FR-003**: A pending payment's deadline MUST be the moment it was recorded plus the limit in
  force at that moment. Changing the setting MUST NOT move an existing deadline.
- **FR-004**: A payment already pending when this feature is released MUST get the release moment
  plus the limit as its deadline.

**When the deadline passes**

- **FR-005**: When a payment's deadline passes with no Verificar or Rechazar, the system MUST
  withdraw that payment within 15 minutes, without an admin. It records «Sistema» as the actor and
  «No se verificó la transferencia a tiempo» as the reason.
- **FR-006**: If, once that payment is withdrawn, the sale holds no other confirmed money, the
  system MUST cancel the sale the way an admin's Rechazar does: seats released, the seller's
  commission reversed, nothing refunded.
- **FR-007**: If the sale still holds confirmed money, the system MUST NOT cancel it. It undoes only
  what the withdrawn payment did:
  - the services it paid owe again;
  - the sale reads as an apartado, keeping its seats, its confirmed payments, the commission those
    earned and its own hold deadline;
  - no tickets are released;
  - every peso of cash the seller collected stays in their balance.
  *(Requires `reject-settle-voids-deposit`.)*
- **FR-008**: A sale returned to an apartado by FR-007 MUST follow the apartado rules from then on.
  It can be settled again before its hold deadline. Past it, it is released on the next run under
  the cancellation policy, as credit and never cash.
- **FR-009**: Verificar, Rechazar and the deadline MUST each resolve a payment at most once, and
  exactly one of them applies. A payment resolved by one MUST be refused by the others, with the
  existing "not awaiting verification" answer.
- **FR-010**: When a sale is cancelled for another reason while its transfer is pending, the
  deadline MUST still resolve that payment as not verified, with no further effect on money or
  seats.
- **FR-011**: Money that was never verified MUST NOT become customer credit when an apartado lapses.

**Visibility and notices**

- **FR-012**: Por verificar MUST show each payment's time left, order payments by deadline (closest
  first), and mark those with less than 2 hours left. The seller MUST see the same time left on the
  sale.
- **FR-013**: The sale's timeline MUST record each withdrawal with «Sistema» as the actor and the
  reason.
- **FR-014**: The customer MUST be told what happened:
  - **sale cancelled**: the payment could not be confirmed, so the sale was cancelled;
  - **returned to an apartado**: the balance payment could not be confirmed; the apartado
    continues with the deposit, and the customer can pay until the hold deadline.

  The notice is emailed when the customer has an address. A WhatsApp message is always queued for
  the seller to send, address or not. Notices go out only after the money change is saved, and
  never undo it (constitution VIII).
- **FR-015**: The seller MUST see on the sale that the payment was withdrawn and why, with the
  customer message ready to send.

**Isolation and copy**

- **FR-016**: The setting, the deadlines and the withdrawals MUST be scoped to the organization. One
  organization's limit or scheduled run MUST never change another's sales (constitution III).
- **FR-017**: All copy follows constitution VII: the sale is «Venta», never "folio"; state is never
  colour alone.

### Key Entities *(include if feature involves data)*

- **Organization setting — transfer verification limit**: whole hours, 1–168, default 24.
- **Electronic payment awaiting verification** *(exists today)*: gains its **deadline**, fixed when
  it is recorded, and its **outcome**: verified, rejected, or withdrawn by the deadline. Each outcome
  records its actor (a person or «Sistema») and its time.
- **Sale** *(exists today)*: its state still follows from its services and their money. A
  withdrawal is a new entry in its timeline.
- **Customer notice** *(exists today)*: gains the two messages of FR-014.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No transfer payment stays pending longer than its organization's limit plus 15
  minutes. Today one has stayed pending for 66 days.
- **SC-002**: Seats held by an unverified full sale or deposit go back on sale within the limit plus
  15 minutes, with no admin action.
- **SC-003**: Zero sales holding confirmed money are cancelled by the deadline, and zero pesos of
  cash a seller collected leave their balance because of it.
- **SC-004**: Every withdrawal produces a customer notice (email when there is an address, and a
  WhatsApp message for the seller) and is visible on the sale.
- **SC-005**: An admin can see the time left of every pending payment in Por verificar without
  opening each sale.
- **SC-006**: Transfers verified or rejected before their deadline behave exactly as today, and the
  scope-boundary suites (Context) pass unedited.

## Assumptions

- The unit is hours and the range is 1–168, matching the apartado's «Plazo para pagar el saldo».
  There is no "off" value: a limit that can be switched off is how a payment ends up pending for 66
  days.
- The deadline counts from when the payment was recorded, not from the departure. It is fixed at
  that moment, like an apartado's hold deadline, so a settings change never moves a deadline already
  running.
- The limit is enforced by the existing scheduled run (every 15 minutes), so a withdrawal lands
  within 15 minutes of its deadline.
- Money that arrives after its payment was withdrawn is handled by the admin outside the system.
  Transfers are 0.5% of payments today (spec 006 Context).
- When spec 006 ships, each payment is followed by exactly one mechanism: its Devolada link, or this
  deadline. The two never govern the same payment.
- The express sale is cash-only and untouched.
