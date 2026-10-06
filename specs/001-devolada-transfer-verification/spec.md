# Feature Specification: Automatic Transfer Verification with Devolada

**Feature Branch**: `claude/flujo-pago-referencia-nlndbe`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Evalúa integrar esta api de validación transferencia automatizada" —
Devolada's collections API v1, supplied as OpenAPI and kept verbatim in
[`contracts/devolada-collections-v1.openapi.yaml`](./contracts/devolada-collections-v1.openapi.yaml),
so that a bank transfer is cleared by Banxico's own record instead of by an admin's glance.

## Context *(constitution I — what is broken, with numbers)*

Today a transfer releases no tickets until a person clears it. The seller records the payment as
**Transferencia**, typing the bank reference if the organization requires it; the sale waits in
**Por verificar**; an admin opens their bank, compares the reference (or the amount and time) by
eye and taps **Verificar**, which signs the tickets, emails them and unlocks the seller's WhatsApp
send (archived `docs/payment-verification/payment-verification.spec.md`: US-AG41, US-A67, US-A88).
The check is a human glance rather than evidence, and it happens only when an admin is looking.

Production, read 2026-10-05 (aggregates only, no customer data):

| Payments since 2026-07-23 | Count | Amount (MXN) |
|---|---|---|
| Cash | 1,003 | $824,520 |
| Transfer | 5 (0.5%) | $7,540 |

- Of the 5 transfers, 3 predate the verification step (grandfathered as verified), 1 was verified
  by an admin within the hour, and **1 ($900, sold 2026-07-31 for a same-day departure) was never
  verified**. Its sale was later cancelled, and the payment still reads *pending* 66 days on.
  No person and no part of the system ever learned whether that money arrived.
- Only 1 of the 2 organizations has ever taken a transfer. A transfer costs two people (the seller
  records it, an admin checks it) and leaves the customer without tickets until the second one acts,
  which for a same-day departure is often too late. **Hypothesis, to be measured rather than
  assumed (SC-008):** this friction is why transfers are rare.

Devolada (`leolicona/devolada`) validates a SPEI transfer against Banxico's record (the CEP) and
reports a verdict per payment. This feature lets an organization connect its own Devolada account
so that its transfers are cleared by that verdict instead of by a person. The manual path stays,
both as the fallback when Devolada is unavailable and as the admin's override.

**Scope boundary (mechanical):** an organization that has not connected Devolada sees no change.
`api-turistear/test/pos/payment-verification.test.ts`,
`api-turistear/test/pos/optional-payment-reference.test.ts` and
`api-turistear/test/paid-ledger/settle-method.test.ts` MUST pass unedited.

## Clarifications

### Session 2026-10-06

- Q: When a payment ends *invalid* or *expired*, or its link expires unpaid, does the sale stay in
  Por verificar or is it cancelled automatically? → A: Cancelled automatically when the link
  expires unpaid or the payment ends *expired*; an *invalid* payment goes to the admin (FR-016).
- Q: What does the seller give the customer — the link only, or also the CLABE and the 7-digit
  payer reference? → A: The link, sent by WhatsApp; the customer confirms the transfer through
  Devolada's link page. Turistear shows neither the CLABE nor the reference (FR-008).
- Q: With Devolada connected, may the seller still record a transfer by hand? → A: No. The link
  replaces the seller's manual recording; the manual path is used only when no link can be
  created, and the admin can always verify by hand (FR-009, FR-010, FR-018).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A transfer sale clears itself when Banxico confirms the money (Priority: P1)

An admin connects the organization's Devolada account once. From then on, when a seller (agent,
affiliate or shift operator) completes a sale by Transferencia, the sale gets its own Devolada
payment link for exactly the amount due. The seller sends the link to the customer by WhatsApp. The
customer transfers from their bank and confirms the transfer on Devolada's link page. When
Devolada reports that Banxico confirms the money, the system verifies the sale: the
tickets are signed, the email goes out if there is an address, and the seller's WhatsApp send
unlocks. No admin is involved.

**Why this priority**: this is the whole value — tickets leave when the money is proven, not when
an admin happens to look. Every other story handles a path that does not end in a clean
confirmation.

**Independent Test**: connect an organization with Devolada **test** credentials, complete a full
sale by Transferencia, move the test payment to *confirmed* with Devolada's test-mode control, and
observe the sale verified by «Sistema» with its tickets released and no admin action.

**Acceptance Scenarios**:

1. **Given** an admin holding a valid Devolada credential, **When** they connect it in Ajustes,
   **Then** the organization shows as connected (real or test), the credential is never displayed
   again except as a masked hint, and the organization's transfer sales start using payment links.
2. **Given** a connected organization, **When** a seller completes a full sale by Transferencia,
   **Then** the sale is created as today (paid, awaiting verification, no tickets) **and** a payment
   link for exactly the sale's amount is attached, the seller can send it to the customer by
   WhatsApp in one tap, and the sale shows as «Verificando pago». The seller is not offered a field to
   type a bank reference.
3. **Given** that sale, **When** Devolada reports the payment *confirmed*, **Then** the sale is
   verified with the system as the actor, its tickets are signed, the ticket email is sent if the
   customer has one, the seller's WhatsApp send unlocks, Devolada's receipt number is recorded as
   the payment's reference, and the sale never enters Por verificar.
4. **Given** a connected organization, **When** Devolada cannot be reached while a seller completes
   a transfer sale, **Then** the sale still completes on today's manual path (awaiting an admin) and
   the seller is told that no payment link could be created. The sale is never lost or blocked.
5. **Given** an organization that has not connected Devolada, **When** a seller sells by
   Transferencia, **Then** everything behaves exactly as today.
6. **Given** two organizations, each connected to its own Devolada account, **When** a verdict
   arrives for a payment of organization A, **Then** only organization A's sale changes, and
   organization B's admins and sellers can neither see nor act on A's connection, links or verdicts
   (constitution III, proven with `seedTwoOrgs`).

---

### User Story 2 - Anything short of a clean confirmation reaches the right person, with the reason (Priority: P2)

Some verdicts are not a clean *confirmed*: the money fell short, Banxico contradicts the receipt,
the transfer was never found, money arrived for a link already closed, the customer must supply
the tracking key, or the organization's validation credit ran out. In every one of these cases
the sale is never released and never silently stuck. When no money arrived at all, the sale is
cancelled automatically so its seats go back on sale. Every other case lands in Por verificar, or
in front of the seller, labelled with what happened, and the admin decides with the evidence in
hand.

**Why this priority**: without it, Story 1 works only on the happy path and every exception
becomes an invisible pending sale — the failure the production numbers already show.

**Independent Test**: with test credentials, move test payments to *partial*, *invalid* and
*unapplied* and observe each in Por verificar with its label and amounts; verify one by hand and
reject another. Then move a full sale's test payment to *expired* and observe the sale cancelled
by «Sistema» with its seats released.

**Acceptance Scenarios**:

1. **Given** a transfer sale whose payment ends *partial*, **When** the admin opens Por verificar,
   **Then** the sale shows «Pago incompleto» with the amount asked and the amount received, and its
   tickets stay unreleased until the admin verifies or rejects it.
2. **Given** a payment that ends *invalid*, **Then** the sale stays in Por verificar labelled
   «Banxico no confirma la transferencia», its tickets are not released, and the admin verifies or
   rejects it.
3. **Given** a full sale or an apartado deposit whose payment ends *expired*, or whose link expires
   with no payment, **Then** the sale is cancelled automatically, the way an admin's Rechazar
   cancels it today (seats released, the seller's commission reversed), with «Sistema» as the
   actor and «No se recibió la transferencia» as the reason.
4. **Given** an apartado's settlement whose payment ends *expired*, or whose link expires with no
   payment, **Then** the settlement is never recorded and the sale stays an apartado, with its
   deposit and its own hold rules intact. A sale is never cancelled automatically while it holds
   money that was cleared. *(Amended by plan D8: a settlement is recorded only once confirmed.)*
5. **Given** money that arrives for a link already closed (*unapplied*) — including a sale
   cancelled under scenario 3 whose customer paid late — **Then** the admin is alerted that money
   arrived for a sale that no longer takes it, with the amount, so they can return it.
6. **Given** a payment waiting for the customer's tracking key, **Then** the seller sees «Pide al
   cliente su clave de rastreo» on the sale, and the sale keeps waiting without expiring.
7. **Given** the organization's validation credit at Devolada has run out, **Then** the admin sees
   that validations are paused until they top up, and the affected sales keep waiting.
8. **Given** any sale still awaiting its verdict, **When** the admin taps Verificar or Rechazar,
   **Then** both behave as today and the record shows the admin, not the system, as the actor.

---

### User Story 3 - Apartados: the deposit and the settlement each get their own link (Priority: P2)

An apartado can take two electronic payments: the deposit, then the settlement. Each gets its own
link for its own amount and is verified on its own verdict. A confirmed deposit holds the seats but
releases no tickets, as today; a confirmed settlement releases them.

**Why this priority**: apartados are the product's second way to sell. Without this story they
fall back to the manual path, and the feature covers only full sales.

**Independent Test**: with test credentials, create an apartado with a transfer deposit and confirm
its test payment (no tickets). Then settle by transfer and confirm the settlement's test payment
(tickets released).

**Acceptance Scenarios**:

1. **Given** a connected organization, **When** a seller creates an apartado with a transfer
   deposit, **Then** a link for exactly the deposit is attached, the seats are held as today, and
   the deposit awaits its verdict.
2. **Given** that deposit, **When** it is confirmed, **Then** the system verifies the deposit and no
   tickets are released.
3. **Given** that apartado, **When** it is settled by transfer, **Then** a new link for exactly the
   balance is attached, and **When** that payment is confirmed, **Then** the tickets are released.
4. **Given** an apartado whose deposit still awaits its verdict, **When** it is settled by transfer,
   **Then** both payments are followed independently and tickets are released only once every
   electronic payment of the sale is cleared.

---

### User Story 4 - A sale that stops taking money closes its link (Priority: P3)

When a sale is cancelled, rejected, expires, or what it owes changes, its open link stops accepting
payment. A customer cannot pay for something that no longer exists, and money that was already on
its way is flagged (Story 2, scenario 5) instead of lost.

**Why this priority**: rare, but each occurrence is real money owed back to a customer; preventing
it is cheaper than chasing it.

**Independent Test**: with test credentials, create a transfer sale, cancel it and observe its link
closed; then advance a test payment to *unapplied* and observe the admin alert.

**Acceptance Scenarios**:

1. **Given** a transfer sale with an open link, **When** the sale is cancelled — by a person or by
   the apartado expiry — **Then** its link is closed.
2. **Given** an open link, **When** a line of the sale is cancelled and the amount due changes,
   **Then** the link is closed and a new link for the new amount replaces it.
3. **Given** a payment with an open link, **When** an admin rejects it, **Then** its link is closed.

---

### Edge Cases

- **The same verdict arrives twice, or two arrive out of order** → it is applied once; a payment
  never moves back from verified; the newer state wins.
- **A verdict's notification is lost** → the system finds the verdict by asking Devolada itself,
  within SC-003's window.
- **A notification about a payment this organization does not own** (another Devolada business, a
  forgery, or a test-mode verdict reaching production) → changes nothing, and is logged for diagnosis.
- **The customer corrects a misread receipt** (*superseded*) → the first payment is ignored and the
  corrected one is followed.
- **The admin verifies by hand while Devolada is still validating** → the manual verification
  stands; a later Devolada verdict is recorded but releases nothing a second time.
- **The customer pays more than asked** (Devolada's fee, or an overpayment) → confirmed; the amount
  received is recorded and shown to the admin, and the sale's total and ledger keep the sale's
  amount.
- **The credential is revoked, or the organization's Devolada business is suspended** → the
  connection shows as broken in Ajustes, the admin is warned, and new transfer sales fall back to
  the manual path until it is fixed.
- **The Devolada account already sends its notifications to another system** → connecting warns the
  admin before replacing that address, because Devolada keeps one address per business.
- **Devolada answers slowly at checkout** → the seller waits no longer than SC-006 allows before
  the sale completes on the manual path (Story 1, scenario 4).
- **A same-day departure leaves before the verdict** → the rule is unchanged: no tickets until the
  money is cleared, and the admin can still verify by hand on the spot.
- **A shift operator sells by transfer** → same flow; the money goes to the organization's account,
  as every electronic payment does today.

## Requirements *(mandatory)*

### Functional Requirements

**Connection**

- **FR-001**: An admin MUST be able to connect the organization's own Devolada account by entering
  its API credential. Connecting is admin-only and per organization: each organization uses its own
  Devolada business, CLABE and validation credit.
- **FR-002**: The system MUST check the credential with Devolada when it is entered, refuse one that
  Devolada rejects, and record whether it is a real or a test credential. Production MUST accept
  only real credentials, so a test payment can never release a real ticket.
- **FR-003**: Once saved, the credential MUST never be shown again or returned to any client; the
  admin sees only that it is connected and a masked hint. It MUST be stored so that reading the
  database alone does not reveal it.
- **FR-004**: The admin MUST be able to disconnect. New transfer sales then use the manual path,
  while payments that already have a link are followed until their verdict.
- **FR-005**: The connection screen MUST show its health: the last verdict received, failing
  notification deliveries, a rejected credential or suspended business, and paused validation
  credit.
- **FR-006**: Before taking over the Devolada account's notification address, the system MUST warn
  the admin when another address is already registered.

**Collecting**

- **FR-007**: For a connected organization, every electronic payment recorded at checkout or at
  settlement (full sale, apartado deposit, settlement) MUST get its own one-time Devolada payment
  link for exactly the amount that payment covers.
- **FR-008**: The seller MUST be able to send the link to the customer by WhatsApp in one tap from
  the sale, as a pre-filled message from the seller's own number. The customer confirms the
  transfer on Devolada's link page; Turistear shows neither the CLABE nor the payer reference —
  the link's page carries them. *(Clarified 2026-10-06.)*
- **FR-009**: When Devolada is connected, the seller MUST NOT be offered the manual recording of a
  transfer (the typed bank reference, cleared by an admin). The link replaces it; the manual path
  exists for the seller only as the FR-010 fallback. *(Clarified 2026-10-06.)*
- **FR-010**: If a link cannot be created (Devolada unreachable or refusing, or the business
  suspended), the sale MUST still complete on today's manual path and the seller MUST be told. A
  sale is never lost or blocked by Devolada, and never delayed beyond SC-006. *(constitution VIII)*
- **FR-011**: A link MUST stop accepting payment when its sale stops taking that money: cancellation
  by anyone, rejection, apartado expiry, a change in the amount due (which issues a replacement
  link), and the link's own expiry (Assumptions).

**Verdicts**

- **FR-012**: The system MUST learn each payment's verdict from Devolada's notifications, and MUST
  also check by itself any payment still awaiting a verdict, so a lost notification never leaves a
  sale stuck.
- **FR-013**: The system MUST NOT act on a notification alone. It MUST establish that the
  notification is authentic, then confirm the verdict with Devolada using the organization's own
  credential before changing a sale. A notification about a payment the organization does not own,
  or whose mode (real or test) does not match the organization's connection, MUST change nothing.
- **FR-014**: A *confirmed* verdict MUST verify that payment exactly as an admin's Verificar does
  today — release the tickets when the sale is fully paid, email them, unlock WhatsApp; for a
  deposit, clear the money without releasing tickets — with the system recorded as the actor and
  Devolada's receipt number recorded as the payment's reference. Applying the same verdict again
  MUST have no further effect.
- **FR-015**: Each of the following MUST be surfaced with its own label and the amounts involved
  (asked, claimed, received): *partial*, *invalid* and *unapplied* verdicts, a payment waiting on
  the customer's tracking key, and paused validation credit. They go to the admin in Por verificar;
  the tracking-key case also goes to the seller. An *expired* verdict or an unpaid link expiry is
  not queued — FR-016 resolves it — and its reason shows on the sale and in its timeline.
- **FR-016**: When a payment ends *expired*, or its link expires unpaid, no money arrived. The
  system MUST then withdraw that payment without waiting for an admin:
  - for a full sale or an apartado deposit, cancel the sale the way an admin's Rechazar does
    (seats released, the seller's commission reversed), with «Sistema» as the actor and «No se
    recibió la transferencia» as the reason;
  - for a settlement, leave the sale an apartado with its deposit and hold rules intact: a
    settlement by link is recorded only once confirmed, so an unpaid one has nothing to withdraw.
    A sale holding cleared money is never cancelled automatically. *(Amended by plan D8.)*

  A payment that ends *invalid* MUST stay in Por verificar for the admin to verify or reject.
  *(Clarified 2026-10-06.)*
- **FR-017**: A *superseded* payment MUST be ignored in favour of its correction. While a payment
  is *validating*, the sale MUST show «Verificando pago» and release nothing.
- **FR-018**: The admin's manual Verificar and Rechazar MUST remain available for every awaiting
  payment of a connected organization, behave as today, and record the admin as the actor and the
  verification as manual.
- **FR-019**: The sale's timeline MUST record each verdict that changes the sale; automatic ones are
  attributed to «Sistema».

**Money, isolation, copy**

- **FR-020**: The sale's total, its ledger and its commission MUST be unaffected by Devolada's fee
  or by any difference in the amount received. The amount received MUST be recorded with the
  payment for audit. *(constitution II)*
- **FR-021**: The connection, its links and its verdicts MUST be scoped to the organization. One
  organization's credential, links or verdicts MUST never affect, or be visible to, another.
  *(constitution III)*
- **FR-022**: Seller- and admin-facing copy follows constitution VII: the sale is «Venta», never
  "folio" — including Devolada's receipt number, which is shown as «Comprobante Devolada».

### Key Entities *(include if feature involves data)*

- **Devolada connection** — at most one per organization: the credential (write-only), its mode
  (real or test), its status (connected · broken · disconnected), the health of its notification
  address, and who connected it and when.
- **Payment link** — one per electronic payment of a sale: the sale and which payment it collects
  (sale · deposit · settlement), the amount asked, the link's address, its expiry, and its state
  (open · paid · expired · closed).
- **Devolada payment (verdict)** — what Devolada reports for a link: its id, status, the amounts
  asked, claimed and received, the match (exact · short · over), Devolada's receipt number, the
  verdict's time, and what it awaits from the customer, if anything.
- **Electronic payment of a sale** *(exists today)* — gains how it was verified (by an admin, or
  automatically through Devolada) and the amount actually received.
- **Verdict notification** — each notification received, kept for de-duplication and diagnosis,
  with whether it changed anything.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a connected organization, at least 95% of the transfer payments Banxico confirms
  release the customer's tickets with no admin action.
- **SC-002**: For 95% of confirmed payments, the tickets are released within 2 minutes of
  Devolada's verdict: the QR is signed, the email is sent when the customer has an address, and the
  seller's WhatsApp send is unlocked. *(Amended by /speckit-analyze A1: delivery by WhatsApp waits
  on the seller's tap, which the system does not control.)*
- **SC-003**: A verdict whose notification was lost is reflected on the sale within 30 minutes.
- **SC-004**: No transfer payment of a connected organization waits more than 24 hours without a
  labelled reason the admin can see (today one has waited 66 days with none).
- **SC-005**: Zero tickets are released for a payment that neither Banxico confirmed nor an admin
  verified — including duplicated, forged, foreign and test-mode notifications.
- **SC-006**: Zero sales are lost, blocked, or delayed more than 5 seconds at checkout because
  Devolada was slow or down.
- **SC-007**: Organizations that have not connected Devolada see no change in behaviour; the
  scope-boundary suites (Context) pass unedited.
- **SC-008**: *(the Context hypothesis, to be measured)* Within 60 days of connecting, transfers
  make up more than 5% of the organization's payments (today 0.5%).
- **SC-009**: Seats held by a sale whose transfer never arrives go back on sale within 30 minutes
  of its link expiring or its payment ending *expired*, with no admin action, while Devolada can be
  reached. During a Devolada outage nothing is cancelled, and the seats return within 30 minutes of
  it answering again. *(Amended by /speckit-analyze I1: a sale is never cancelled on the clock
  alone — research D9.)*

## Assumptions

- Each organization connects its **own** Devolada business: its own CLABE, validation credit and
  credential. The money lands in the organization's account; Turistear never holds it.
- Connecting is opt-in per organization. An organization that never connects keeps today's flow
  (scope boundary).
- One one-time link per electronic payment. The customer identity Devolada sees is the sale, so all
  the links of one sale share the customer's payment reference.
- A link stays open until whichever comes first: 24 hours after it is issued, or the start of the
  sale's first service. FR-016 decides what happens when it closes unpaid. Because closing unpaid
  now cancels the sale, this window is a product decision; the plan may tune it, but never past the
  first service.
- The organization's «Referencia obligatoria en transferencias» switch (US-A88) applies only to the
  manual path. A linked payment's reference is Devolada's receipt number.
- A fee the organization configures in Devolada is charged to the customer on top of the amount
  due. It belongs to the organization's arrangement with Devolada; Turistear neither adds nor
  accounts for it.
- An overpayment counts as confirmed. The admin returns any excess, or *unapplied* money, outside
  the system. Deferring that is safe because Devolada reports the amounts, the admin is alerted
  (FR-015), and transfers are 0.5% of payments today.
- The express sale is cash-only and is untouched.
- Customer messages travel as today: email is sent automatically, WhatsApp by the seller's tap.
  Turistear sends no WhatsApp itself — the payment link included (FR-008).
- Devolada behaves as its v1 contract states (`contracts/devolada-collections-v1.openapi.yaml`).
  The plan records what breaks when it is down (constitution VIII). Its rate limit, 120 requests a
  minute per business, is far above any organization's sales rate.
