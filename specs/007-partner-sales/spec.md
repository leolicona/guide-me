# Feature Specification: Partner Sales — tourists a hotel sends under a convenio

**Feature Branch**: `feat/partner-sales`

**Created**: 2026-10-16

**Status**: Draft

**Input**: User description, verbatim: *"EL admin del negocio (dueño) quiere registrar ventas de
terceros con los que mantiene un convenio. Ejemplo: el gerente del hotel “Imperial” manda 10
turistas para el recorrido “Noche de Leyendas”, el hotel lo notifica por mensaje o manda al turista
con una nota que dice: numero de lugares, costo final acordado y anticipo. El anticipo lo recibe el
Hotel, el agente en taquilla registra la venta cobra el resto sobre consto acordado. El admin y el
hotel tienen una reunión periódica en donde hacen cuentas. El admin le da un costo al cada hotel."*

## Context *(constitution I — what is broken, with numbers)*

A hotel (or any business the organization has an agreement with — a **convenio**) sells the
organization's tours to its own guests. It agrees a final price with the tourist, collects part of
it as an **anticipo**, and either sends the tourist to the ticket booth with a note — places,
agreed price, anticipo — or announces them by message. The agent at the booth collects the rest.
The anticipo stays with the hotel. Periodically the admin and the hotel meet and settle accounts,
against a net price per place the admin agreed with that hotel.

None of that has a place in the product today. Production, read 2026-10-16 (aggregates only, no
customer data):

| Production since 2026-07-23 | Count |
|---|---|
| Sales (one organization) | 1,011 |
| Sales that record who sent the tourist | **0** — no field exists |
| Payment rows by method | cash 1,005 · transfer 5 · any third party 0 |
| Live sales of «Leyendas Huasca» (the night legends tour) | 621, 2,140 seats |
| …of them sold below the usual $150 per place ($110–$140) | 40 sales, 201 seats |

- **The anticipo has nowhere to go.** Every payment the ledger records names the user who took the
  money and a method among cash, card, transfer and link. Money a hotel took is none of those. If
  the agent records the agreed price, their cash is expected to hold the anticipo they never
  received; if they record only what they took, the sale reads as a seller's discount.
- **The agreed price may not fit.** A seller's price must lie between the service's minimum and
  base price ($110–$180 for «Leyendas Huasca»). An agreed price above the base, or a booth
  remainder below the minimum, cannot be recorded at all.
- **The booth earns a commission it did not earn.** Every sale accrues the service's commission
  for its seller, out of the cash they hand in. A sale the hotel made should accrue none.
- **Nothing says which hotel sent whom.** The 40 cheaper sales above may be hotel guests or may be
  ordinary discounts; the data cannot tell, and neither can the admin. The meeting with each hotel
  is therefore prepared from paper notes and chat messages, outside the product, and an anticipo
  the agent mistyped, or a note that never reached the admin, surfaces only if someone remembers it.
- **A group announced by message holds no places.** Until the tourists reach the booth, nothing
  keeps their departure from selling out.

The affiliate program, retired in `specs/001-retire-affiliates`, made the partner a user with its
own role, portal and cash, and never reached real use. This feature takes the opposite shape: **the
partner is not a user**. It is a record the admin keeps — a name, a contact and a net price per
service — that sales are attributed to and that accounts are settled against. The product keeps
its two roles (constitution III).

**Scope boundary (mechanical):** an organization that registers no convenio sees no change, and a
sale with no convenio behaves exactly as today. These suites cover the paths this feature touches
(selling, apartados, cash, commissions, cancellation, the sale list and detail, reports) and MUST
pass **unedited**:

- `api-turistear/test/pos/pos-controlled-discount.test.ts`, `express-sale.test.ts`,
  `pos-bookings-create.test.ts`, `pos-bookings-settle.test.ts`, `pos-bookings-sweep.test.ts`,
  `pos-bookings-cancel.test.ts`, `payment-verification.test.ts`
- `api-turistear/test/paid-ledger/` (every suite)
- `api-turistear/test/cash/advanced-cash-collection.test.ts`, `agent-balance-cash-drops.test.ts`,
  `agent-balance-ux-overhaul.test.ts`
- `api-turistear/test/commissions/service-based-commission.test.ts`
- `api-turistear/test/folios/folio-cancellation.test.ts`, `line-cancellation.test.ts`,
  `line-settle.test.ts`, `folio-list-search.test.ts`, `folio-surface-parity.test.ts`,
  `derived-status.test.ts`
- `api-turistear/test/reports/commission-report.test.ts`
- `api-turistear/test/dashboard/` (every suite)
- `api-turistear/test/multitenancy/multitenancy.test.ts`

## Clarifications

### Session 2026-10-24

- Q: What is the cost the admin gives each hotel? → A: A **net price per place**, per service:
  what the business must end up with for each place the hotel sends. The hotel keeps whatever it
  agreed with the tourist above it (FR-002, FR-015).
- Q: When the hotel announces tourists by message, can the sale be registered before they arrive,
  to hold the places? → A: Yes. The places are held as an apartado whose deposit is the hotel's
  anticipo; the booth collects the rest when the tourists arrive. If they never arrive, the
  apartado expires under the organization's current rules (FR-005, Story 4).
- Q: What commission does the booth agent earn on a convenio sale? → A: **None** — the hotel made
  the sale. The booth agent is paid a fixed salary, which belongs to another feature (FR-012).

## User Scenarios & Testing *(mandatory)*

The examples below share one setup. The admin has a convenio with **Hotel Imperial** and has
agreed these net prices with it: **$120** per place on «Leyendas Huasca» and **$250** per place on
«Conde Bus».

### User Story 1 - The booth registers a convenio sale from the hotel's note and collects the rest (Priority: P1)

Ten guests of Hotel Imperial arrive at the booth with a note: 10 places on tonight's «Leyendas
Huasca», agreed price $1,800, anticipo $800. The agent chooses **Venta por convenio**, picks Hotel
Imperial, the departure and the 10 places, and types the agreed price and the anticipo from the
note. The screen shows, before anything else, what is left to collect: **$1,000**. The agent
collects it in cash and the tickets go out as for any sale. The sale reads as Hotel Imperial's,
with $800 paid at the hotel and $1,000 paid at the booth. The agent's cash grows by $1,000 — never
by $1,800 — and no commission accrues.

**Why this priority**: it is the request, and it happens at the booth every day. Without it the
agent either loses the price or loses the anticipo, and the admin loses the hotel.

**Independent Test**: seed a convenio with a net price for one service; sign in as an agent;
register a convenio sale with an agreed price and an anticipo; collect the rest in cash. The sale,
its tickets, the agent's cash balance, their commission and the day's figures are checked against
the numbers above.

**Acceptance Scenarios**:

1. **Given** an active convenio with a net price for the service, **When** an agent registers 10
   places at an agreed price of $1,800 with an $800 anticipo and collects $1,000 in cash, **Then**
   the sale totals $1,800, reads as paid, names Hotel Imperial, shows $800 paid at the convenio and
   $1,000 paid at the booth, and its tickets are issued as for any paid sale.
2. **Given** that sale, **When** the agent's cash balance and the day's money collected are read,
   **Then** each grew by exactly $1,000; the $800 appears in neither, nor in any electronic total.
3. **Given** that sale, **When** the agent's commissions are read, **Then** it accrued none, even
   though the service carries a commission for ordinary sales.
4. **Given** an agreed price per place above the service's base price, or a booth remainder that
   would be below its minimum price, **When** the sale is registered, **Then** it is accepted: the
   price of a convenio sale is the one on the note, not a seller's discount.
5. **Given** an anticipo greater than the agreed price, **When** the agent confirms, **Then** the
   sale is refused with `PARTNER_DEPOSIT_EXCEEDS_TOTAL` and nothing is written.
6. **Given** an anticipo equal to the agreed price, **When** the agent confirms, **Then** nothing
   is collected at the booth and the tickets are issued at once.
7. **Given** the departure has fewer free places than the note asks for, **When** the agent
   confirms, **Then** the sale is refused exactly as any sale is (`SLOT_UNAVAILABLE`), and the
   agent can register it on another departure.
8. **Given** the remainder is paid by transfer, **When** the agent confirms, **Then** the
   remainder follows today's transfer verification, and the tickets wait for it exactly as for any
   transfer.
9. **Given** an agent, **When** they choose the convenio, **Then** they see its name only — never
   its net prices nor what it owes.

---

### User Story 2 - The admin keeps the list of convenios and the net price each one pays (Priority: P1)

The admin opens **Convenios**, adds Hotel Imperial with its contact and phone, and sets the net
price per place on each service the hotel sells. Later the admin raises the «Leyendas Huasca» net
price to $130: tomorrow's sales use $130, while every sale already made keeps $120. When the
agreement ends, the admin deactivates the convenio: the booth can no longer choose it, but its
sales and its accounts stay.

**Why this priority**: a convenio sale needs a convenio and its net price. Without the net price,
no account can be settled (Story 3).

**Independent Test**: as an admin, create a convenio, give it net prices on two services, change
one, deactivate it; as an agent, try to sell under it before and after.

**Acceptance Scenarios**:

1. **Given** an admin, **When** they create a convenio with a name already used by another
   convenio of the organization (ignoring case and surrounding spaces), **Then** it is refused with
   `PARTNER_NAME_TAKEN`.
2. **Given** a convenio with a net price of $120 per place on a service, **When** the admin changes
   it to $130, **Then** sales made afterwards use $130 and every earlier sale keeps $120
   (constitution II: a sale freezes its terms).
3. **Given** a convenio with no net price on a service, **When** the booth tries to sell that
   service under it, **Then** the sale is refused with `PARTNER_RATE_MISSING`, and the message
   tells the agent to ask the admin to add it or to sell it as an ordinary sale.
4. **Given** a deactivated convenio, **When** the booth tries to sell under it, **Then** it is
   refused with `PARTNER_INACTIVE`; its sales, statement and settlements remain visible to the
   admin, and reactivating it restores selling.
5. **Given** an agent, **When** they try to create, edit or deactivate a convenio or to read or
   change its net prices, **Then** the request is refused; only an admin manages convenios.

---

### User Story 3 - The admin brings an exact statement to the meeting (Priority: P2)

Before meeting the hotel, the admin opens Hotel Imperial's **Estado de cuenta**. It lists every
sale since the last settlement — date, departure, service, places, the agreed price, the anticipo
the hotel took, what the booth collected, the net price owed — and nets them into one line: who
owes whom, and how much. The admin can share or print it, and the hotel can check each line
against its own copies of the notes.

With the two sales below, the statement reads **«Le debes $200 a Hotel Imperial»**:

| Sale | Places | Agreed price | Anticipo (hotel) | Booth | Net price | Balance of the sale |
|---|---|---|---|---|---|---|
| «Leyendas Huasca» | 10 | $1,800 | $800 | $1,000 | 10 × $120 = $1,200 | hotel owes $200 |
| «Conde Bus» | 4 | $1,400 | $0 | $1,400 | 4 × $250 = $1,000 | business owes $400 |
| **Net** | | | | | | **business owes $200** |

The balance of a sale is what the business must end up with — the net price of its places — minus
what the booth already collected for it. The hotel keeps whatever it agreed above the net price,
out of the anticipo it holds: on the first sale it holds $800, keeps its $600 margin and owes the
other $200.

**Why this priority**: it is what the admin does at the meeting today on paper. It needs Story 1's
sales to exist, but it is what turns them into money.

**Independent Test**: seed the two sales above; open the statement; check every line, the net
balance and its direction; share it.

**Acceptance Scenarios**:

1. **Given** the two sales above, **When** the admin opens Hotel Imperial's statement, **Then** it
   shows both lines with the figures above and a net balance of $200 owed by the business to the
   hotel.
2. **Given** a convenio sale whose remainder was paid by transfer and is not verified yet, or one
   still held as an apartado waiting for its tourists (Story 4), **When** the statement is read,
   **Then** the sale is listed apart, as pending, and stays out of the net balance until its money
   is cleared or its places are released.
3. **Given** a convenio sale that was cancelled or expired, **When** the statement is read,
   **Then** its released places owe nothing to either side and the sale is shown as cancelled
   (FR-017).
4. **Given** a cut-off date, **When** the admin narrows the statement to departures up to it,
   **Then** the net covers exactly those sales.
5. **Given** a statement, **When** the admin shares or prints it, **Then** the copy carries the
   same lines and net balance the screen shows.
6. **Given** another organization's convenio, **When** an admin asks for its statement, **Then**
   the answer is not found (constitution III).

---

### User Story 4 - The hotel announces a group by message, and the places wait for them (Priority: P2)

At noon Hotel Imperial's manager sends a WhatsApp: 10 guests for tonight's «Leyendas Huasca»,
agreed price $1,800, anticipo $800 already taken. The agent (or the admin) registers the convenio
sale right away, with nothing collected at the booth. The 10 places are held as an apartado whose
deposit is the hotel's $800, with a $1,000 balance. At 8 pm the guests arrive; the agent finds the
sale and collects the $1,000 — **Liquidar saldo**, as for any apartado — and the tickets go out.
Had they never arrived, the apartado would have expired at its release time, exactly as any
apartado does today, and its places gone back on sale.

**Why this priority**: the request names the message as one of the two ways a group arrives, and a
popular night tour can sell out between the message and the arrival. Story 1 already covers the
note.

**Independent Test**: as an agent, register a convenio sale with no booth collection for a future
departure; check that the places are held and the balance is $1,000; settle it in cash; separately,
let another one reach its release time unpaid.

**Acceptance Scenarios**:

1. **Given** an active convenio and a departure with free places, **When** the agent registers a
   convenio sale with an $800 anticipo and collects nothing, **Then** the places are held, the sale
   reads as an apartado with $800 paid at the convenio and a $1,000 balance, and no ticket is
   issued yet.
2. **Given** that apartado, **When** the tourists arrive and the agent collects the $1,000, **Then**
   the sale reads as paid, the tickets are issued, the agent's cash grows by $1,000 and no
   commission accrues.
3. **Given** that apartado, **When** its release time passes unpaid, **Then** it expires under the
   organization's apartado rules, its places return to sale, nothing is refunded by the business,
   and the convenio owes nothing for it (FR-017).
4. **Given** an anticipo below the organization's minimum apartado deposit, including zero,
   **When** the agent registers the advance sale, **Then** it is accepted: the convenio itself
   stands behind the places.
5. **Given** a departure closer than the organization allows an apartado to be opened, **When** the
   agent registers an advance convenio sale for it, **Then** it is refused exactly as any apartado
   is (`BOOKING_TOO_LATE`), and the group can still be registered when it arrives (Story 1).

---

### User Story 5 - The admin records what was settled, and the next statement starts from there (Priority: P3)

At the meeting the hotel and the admin agree the numbers, and the admin pays the hotel $200 in
cash. The admin taps **Registrar pago**, chooses the direction, the amount, the method and the
cut-off date. The two sales leave the open statement and appear in the convenio's history under
that settlement. If they had agreed a different figure — the hotel disputed a line, or paid only
part — the admin records what actually changed hands with a note, and the difference opens the
next statement.

**Why this priority**: without it the statement grows forever and the admin cannot tell what is
already settled; but Story 3 alone already replaces the paper.

**Independent Test**: seed a statement, record a settlement for its exact net, then another for a
different amount; read the open statement and the history after each.

**Acceptance Scenarios**:

1. **Given** the $200 statement, **When** the admin records a $200 payment from the business to
   the hotel up to today, **Then** the open statement is empty with a zero balance, and the
   history shows the settlement with its two sales.
2. **Given** a $500 balance owed by the hotel, **When** the admin records a $300 payment from the
   hotel with a note, **Then** the next statement opens with $200 still owed by the hotel, with
   that note, before any new sale.
3. **Given** a sale listed as pending (Story 3, scenario 2), **When** a settlement is recorded,
   **Then** that sale is not covered by it and stays on the open statement.
4. **Given** a recorded settlement, **When** the admin discovers it was wrong, **Then** it is
   corrected by recording another settlement; no settlement is ever edited or deleted, and both
   remain in the history.
5. **Given** a settlement, **When** any agent's cash balance is read, **Then** it is unchanged:
   accounts with a convenio are the admin's, never an agent's cash.

---

### Edge Cases

- **Agreed price not divisible by the places** ($1,000 for 3): the sale totals exactly the agreed
  price, to the centavo; no centavo is created or lost when it is split across places or lines.
- **Anticipo of zero** (the hotel took nothing): valid. The booth collects everything and the
  business owes the hotel whatever was agreed above the net price.
- **Agreed price below the net price**: valid. The hotel loses on that sale and owes the
  difference; the statement shows it like any other line.
- **The agent mistypes the anticipo or the price**: the statement lists both for every sale, so
  the hotel's copy of the note exposes it at the meeting; the admin records what was actually
  agreed with a note (Story 5). The sale itself is never rewritten.
- **A note with several services** (Leyendas and Conde Bus): one convenio sale may carry several
  services, each priced by the note and owed at that service's net price, with one anticipo for
  the whole note.
- **The message has no tourist phone**: the convenio's contact phone may stand in, so the
  apartado's reminder and the tickets reach the hotel, which forwards them.
- **Fewer tourists arrive than were announced**: the agent cancels the advance sale — the booth
  collected nothing, so nothing is refunded — and registers those who arrived as a new convenio
  sale with the agreed price and anticipo for them. Reducing the places of a held sale in place is
  not in scope.
- **The group arrives after its apartado expired**: the places were released; the agent registers
  a new convenio sale if the departure still has room.
- **A cancelled convenio sale**: the business refunds at most what the booth collected, under the
  organization's cancellation policy; it never refunds the anticipo, which it never held. The
  released places leave the hotel's balance (FR-017).
- **A sale cancelled after its settlement**: the change appears as an adjustment line on the
  convenio's next statement; the settlement is not reopened.
- **A convenio renamed**: past sales and statements show the current name; the money terms of
  every sale stay frozen.
- **A convenio deactivated with an open balance or held apartados**: no new sale can be made under
  it; its held apartados can still be paid at the booth, and its statement and settlements stay
  available.
- **Express sales and stays**: a convenio sale is never an express sale; lodging is out of scope
  (Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

**Convenios and their net prices**

- **FR-001**: Admins MUST be able to create, edit, deactivate and reactivate convenios, each with a
  name unique within the organization (`PARTNER_NAME_TAKEN`), an optional contact name and phone,
  and an optional note. Agents MUST NOT manage convenios.
- **FR-002**: For each convenio and each seat-based service, the admin MUST be able to set, change
  or remove the convenio's **net price per place**: what the business must end up with for each
  place the convenio sends. The convenio keeps whatever it agrees with the tourist above it. A
  change applies only to sales made afterwards.
- **FR-003**: An agent MUST see a convenio's name only; its net prices, balances, statement and
  settlements MUST be visible to admins only, enforced by the server.

**Registering a convenio sale**

- **FR-004**: Agents and admins MUST be able to register a **convenio sale**: an active convenio,
  one or more seat-based services with their departures and places, the agreed price as written on
  the note or message (per service), the anticipo the convenio took for the whole sale, an
  optional reference of the note, and the customer data any sale requires. Capacity is guarded as
  for any sale (constitution V).
- **FR-005**: A convenio sale MUST be registrable either when the tourists are at the booth, the
  remainder collected in the same step (Story 1), or in advance from the convenio's message, with
  nothing collected at the booth (Story 4). An advance sale with a remainder MUST be an apartado
  whose deposit is the convenio's anticipo: it holds its places, runs the organization's apartado
  clock, reminder and release, obeys its creation cutoff, and is paid at the booth through the
  existing settle flow. The organization's minimum apartado deposit MUST NOT apply to a convenio's
  anticipo.
- **FR-006**: The agreed price MUST be the sale's price, exact to the centavo, and greater than
  zero. It MUST NOT be bound by the service's minimum and base prices, and MUST NOT be recorded as
  a seller's discount.
- **FR-007**: The anticipo MUST be between zero and the agreed price, inclusive
  (`PARTNER_DEPOSIT_EXCEEDS_TOTAL` otherwise).
- **FR-008**: The system MUST refuse a convenio sale under an inactive convenio
  (`PARTNER_INACTIVE`) or for a service without a net price for that convenio
  (`PARTNER_RATE_MISSING`), with a message the agent can act on, and write nothing.
- **FR-009**: The booth MUST collect the remainder (agreed price − anticipo) by the organization's
  existing payment methods and rules. The anticipo MUST count toward the sale being paid, so the
  tickets are issued once the remainder is collected and cleared, exactly as for any sale.
- **FR-010**: The anticipo MUST be recorded in the ledger as a movement of its own, dated at the
  sale and attributed to the convenio, never to a user. It MUST NOT count in any seller's cash
  balance, in the day's money collected, or in any electronic total.
- **FR-011**: A convenio sale MUST freeze its convenio terms when sold: the convenio, the net price
  per place of each service, the agreed price and the anticipo (constitution II).
- **FR-012**: A convenio sale MUST accrue no commission for its seller — neither when it is sold
  nor when its apartado balance is paid — whatever commission the service carries for ordinary
  sales. The booth agent's fixed salary is out of scope (another feature).
- **FR-013**: The receipt, the sale detail and the tourist's tickets page MUST show the agreed
  price, the anticipo paid at the convenio (by name) and the amount paid at the booth, with the
  remainder reading first at checkout and on a held sale. The sale list MUST mark convenio sales,
  and the admin MUST be able to filter it by convenio.

**Accounts with the convenio**

- **FR-014**: For each convenio the admin MUST be able to read a statement of every convenio sale
  not yet covered by a settlement, optionally up to a cut-off departure date. Each line shows the
  sale's date, departure, services, places, agreed price, anticipo, booth collection, net price
  owed and the sale's balance; the statement shows the balance carried from the last settlement
  and the net balance with its direction. A sale whose booth money is not cleared yet, or that is
  still held as an apartado, MUST be listed apart as pending and stay out of the net balance.
- **FR-015**: The balance of a sale MUST be the net price of its live places minus the net amount
  the booth collected for it (payments less refunds); a positive balance is owed by the convenio,
  a negative one by the business. The statement and every figure in it MUST be derived from
  recorded movements, never stored as an independent fact (constitution II).
- **FR-016**: The admin MUST be able to share or print a statement, carrying the same lines and net
  balance as the screen.
- **FR-017**: Released places — cancelled, or expired as an unpaid apartado — MUST owe nothing to
  either side in the convenio's balance. A cancellation or expiry MUST NOT refund more than the
  booth collected, and MUST NOT refund or retain the anticipo, which the business never held. A
  change to a sale already covered by a settlement MUST appear as an adjustment on the convenio's
  next statement.
- **FR-018**: The admin MUST be able to record a settlement with a convenio: the direction (the
  convenio pays the business, or the business pays the convenio), the amount, the method, the date,
  the cut-off departure date and an optional note. The settlement MUST cover the convenio's
  non-pending sales up to its cut-off, and any difference between the amount and their net balance
  MUST carry forward to the next statement, with the note.
- **FR-019**: A settlement MUST NOT be edited or deleted; a mistake is corrected by recording
  another. Settlements MUST NOT change any agent's cash balance.
- **FR-020**: The admin MUST be able to see, for a period, how many sales and places each convenio
  brought and how much money (agreed prices, anticipos, booth collections, net prices owed).

**Isolation and errors**

- **FR-021**: Convenios, their net prices, convenio sales and settlements MUST be scoped to the
  organization: another organization's convenio answers not found on every route, proven by
  cross-organization tests (constitution III).
- **FR-022**: Every refusal MUST answer one of the codes this spec declares — `PARTNER_NAME_TAKEN`,
  `PARTNER_INACTIVE`, `PARTNER_RATE_MISSING`, `PARTNER_DEPOSIT_EXCEEDS_TOTAL` — or an existing
  code (`SLOT_UNAVAILABLE`, `ZONE_UNAVAILABLE`, `SLOT_CLOSED`, `BOOKING_TOO_LATE`,
  `VALIDATION_ERROR`, `FORBIDDEN`, not found).

### Key Entities *(include if feature involves data)*

- **Convenio** (partner): a business the organization has an agreement with — name, contact,
  phone, note, active or not. It is not a user and has no access to the product.
- **Net price**: what the business must end up with per place a convenio sends on one service
  (FR-002). Changing it never re-prices a sold sale.
- **Convenio sale**: a sale attributed to one convenio, carrying the agreed price, the anticipo,
  the note's reference and the frozen net price per place of each service. Paid at the booth at
  once, or held as an apartado until the tourists arrive.
- **Convenio anticipo**: the part of a convenio sale the tourist paid to the convenio — a ledger
  movement held by the convenio, counted in its accounts, never in a seller's cash.
- **Settlement**: what changed hands between the admin and a convenio at a meeting — direction,
  amount, method, date, cut-off, note — and the convenio sales it covers.
- **Statement**: the derived view of a convenio's open sales, their balances and the balance
  carried forward. Never stored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the sales a convenio sends are recorded with their convenio, agreed price
  and anticipo; for any period the admin can say how many tourists and how much money each
  convenio brought (today: 0 sales record it).
- **SC-002**: An agent registers a convenio sale from a note and collects the remainder in no
  more steps than an ordinary sale of the same places, and under one minute once the tourists are
  at the booth.
- **SC-003**: No agent's cash balance ever includes a convenio's anticipo or a commission on a
  convenio sale: after every convenio sale, the seller's expected cash grows by exactly what the
  booth collected in cash.
- **SC-004**: For every convenio and every settled period, the net prices of the settled sales
  equal, to the centavo, what the booth collected for them plus what the settlements moved — the
  accounts close at zero difference, or the difference is the one the admin recorded with a note.
- **SC-005**: The admin prepares a meeting — opens a convenio's statement and shares it — in under
  two minutes, with no paper notes.
- **SC-006**: Places a convenio announces in advance are held from the moment the message is
  registered, and those whose tourists never arrive return to sale at the apartado's release time
  with no admin action.
- **SC-007**: An organization that registers no convenio sees no change; the scope-boundary suites
  (Context) pass unedited.

## Assumptions

- **The convenio is not a user.** It never signs in, has no portal and holds no cash in the
  product; the admin speaks for it. The product keeps exactly two roles, `admin` and `agent`
  (constitution III), and avoids the shape of the retired affiliate program
  (`specs/001-retire-affiliates`).
- **Seat-based services only.** Convenio sales cover tours and transfers sold by departure and
  place. Stays (lodging) are out of scope; a hotel sending guests to the organization's cabins is
  not the case described.
- **One convenio per sale.** A sale belongs to at most one convenio and is either a convenio sale
  or an ordinary one from the moment it is sold.
- **The note is trusted at the booth.** The agent types what the note or message says; the control
  is the meeting, where the convenio checks every line against its copies. Photographing the note
  is not in scope.
- **The anticipo counts as paid.** The organization trusts its convenios: tickets are issued once
  the booth remainder is collected, without waiting for the convenio to settle, and an advance
  sale's places are held whatever the anticipo (FR-005).
- **The anticipo is the convenio's business.** When places are released — the tourist cancels, or
  never arrives — the business neither refunds nor keeps any part of the anticipo; what the
  convenio does with it is between the convenio and its guest (FR-017). A no-show charge to the
  convenio is not in scope. *(Default chosen by this spec; the first candidate for
  `/speckit-clarify`.)*
- **Customer data** follows today's rules for a sale and an apartado (name and a dialable phone);
  the tickets go out by the same channels.
- **Settlements happen outside the product.** The money changes hands in person or by transfer;
  the product records it, it does not move it, and no service we do not own is involved
  (constitution VIII).
- **Copy.** «Convenio» names the partner and «Venta por convenio» the sale (constitution VII: one
  word per concept). Paying a held sale's balance keeps the apartado's «Liquidar saldo». The money
  the convenio took must not read as «Anticipo» alone, which already names an apartado's deposit
  collected by the booth, and the meeting's settlement must not use «Liquidar»; the plan fixes the
  final words (working labels: «Pagado en el convenio», «Estado de cuenta», «Registrar pago»).
- **The archive was not read.** `leolicona/guide-me-docs` was not reachable from this session;
  `/speckit-plan` should check the retired affiliate specs it holds for lessons on partner
  commissions.
