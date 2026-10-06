# Feature Specification: Delete the legacy affiliate users

**Feature Branch**: `feat/delete-legacy-affiliates`

**Created**: 2026-10-06

**Status**: Implemented

**Input**: the developer, after `specs/002-drop-affiliate-tables` shipped: *"Remove them, all
affiliates must be removed"*. Asked how the remaining affiliate users should go, they chose
**"Delete user and their sales"**. They chose it over two alternatives:
- converting the rows to suspended agents and keeping the money;
- fixing the rows by hand.

The choice was made knowing it removes those sales from history and reports. Pays the rest of debt
`affiliate-tables`.

## What is left, with numbers

001 retired the affiliate program from the code and 002 dropped its tables. Each environment still
holds one `users` row stored with the retired role `affiliate`, and the sales it made.

Read through the database API on 2026-10-06:

| | prod — "Lidia Cruz" | dev — "Diana" |
| --- | --- | --- |
| Sales (all paid, none cancelled) | 1 · MXN 360.00 | 3 · MXN 11,600.00 |
| Sale lines (all departure seats) | 1 · 2 seats | 3 · 30 + 30 + 1 seats |
| Ledger rows (payment + commission per sale) | 2 | 6 |
| Payment allocations | 1 | 3 |
| Timeline events | 2 | 8 |
| Ticket links | 1 | 3 |
| Cash drops | 1 · MXN 300.00 confirmed | 3 · MXN 10,380.00 confirmed |
| Payouts, expenses, notifications, requests, lodging stays, reset tokens, invitations | 0 | 0 |
| Rows of anyone else that name this user | 0 | 0 |

001 kept three guards in the code for that row:
- the login refusal (retire-affiliates D3);
- two report labels that print an unknown stored role as-is (D6).

They exist only because the row exists. Debt `affiliate-tables` stays open until they go.

## Scope boundary

In scope:
- One migration that deletes every user stored with role `affiliate`, together with everything tied
  to them, and hands back the departure seats their live sales held.
- Removing the three guards. The product's roles are typed as exactly `admin` and `agent` again.
- Amending the constitution sentence that describes the refusal.

Out of scope:
- Anything of any other user.
- The cash-holder rule (001 D5 — every non-admin user holds cash). With two roles it already means
  "agents"; only its comment changes.
- The person's identity in the external auth service, which the product does not own.

The mechanical test: every API and app suite passes. All of them pass **unedited** except
`test/retire-affiliates/retire-affiliates.test.ts`, whose cases for the refusal and the legacy
seller's money test the guards this change removes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - No affiliate is left, and nothing of theirs (Priority: P1)

After migrating:
- no user is stored with role `affiliate`;
- no sale, sale line, ledger row, allocation, timeline event, ticket link, notification, request or
  lodging stay of theirs remains;
- no cash drop, payout, expense or reset token of theirs remains.

The departures their live sales occupied get those seats back. Nothing that belongs to any other
user changes.

**Why this priority**: it is the request.

**Independent Test**: seed two organizations. In one, put a user stored as `affiliate` with:
- a paid sale on a departure;
- a paid sale on a zoned departure;
- a lodging stay;
- a line already cancelled;
- a cash drop and a payout.

Also give that organization an agent who sold on the same departures. Run the migration, then read
both organizations.

**Acceptance Scenarios**:

1. **Given** that seeded database, **When** the migration runs, **Then** no `affiliate` user and no
   row tied to one remains.
2. **Given** the same database, **When** the migration runs, **Then** each departure's booked seats
   fall by exactly the seats of the affiliate's live lines, never below zero. A zoned departure
   drops in its zone first, and the departure's totals are then re-derived from its zones. Seats
   already released by a cancellation are not released twice.
3. **Given** the same database, **When** the migration runs, **Then** every row of the agent and of
   the other organization is unchanged.
4. **Given** a row of another user that names an affiliate (say, a payment they collected), **When**
   the migration runs, **Then** it fails and changes nothing, rather than delete or rewrite another
   user's record.
5. **Given** a database with no affiliate user, **When** the migration runs, **Then** it changes
   nothing.

---

### User Story 2 - The product knows two roles, with no exception (Priority: P2)

The sign-in check refuses a suspended account, and nothing else about roles. The commission report
and its CSV label every seller as Administrador or Agente.

**Why this priority**: once no affiliate exists, the guards are dead code that still describes a
role the product no longer has.

**Independent Test**: sign in as an admin, an agent and a suspended agent. Export the commission
report.

**Acceptance Scenarios**:

1. **Given** an active admin or agent, **When** they use the product, **Then** they are let in.
2. **Given** a suspended account, **When** it makes any request, **Then** it is refused with the
   account-suspended answer and its session cookies are cleared.
3. **Given** a session of a user deleted by the migration, **When** it makes any request, **Then**
   it is refused as a user that no longer exists. When that person tries to log in, the attempt is
   refused as invalid credentials.
4. **Given** sellers in a period, **When** the admin exports the commission report, **Then** each
   row's role reads Administrador or Agente.

### Edge Cases

- **A sale already cancelled, or a line already cancelled**: its seats were released when it was
  cancelled. Releasing them again would free seats that other sales hold.
- **A departure whose booked count was edited by hand below the affiliate's seats**: the count
  stops at zero, as every cancellation does.
- **A legacy session or refresh token** held by the deleted person: it opens nothing. The product
  answers "user no longer exists" for a missing user row.
- **The same email signs up again later**: sign-up treats it like any new email. It gets a new,
  empty organization and no link to the old one.
- **Order of deploy**: the migration runs before the new code is deployed. The code it replaces,
  which still has the guards, keeps working on a database without affiliates. The new code relies
  on there being none. The order is the deploy's own: migrate, then deploy.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: One migration MUST delete every user stored with role `affiliate`. With them it MUST
  delete:
  - every sale whose seller is one of them;
  - every row tied to those sales: lines, line extras, payment allocations, ledger rows, timeline
    events, notifications, requests, ticket links and lodging stays;
  - their cash drops, payouts, expenses and password-reset tokens.
- **FR-002**: Before deleting the sales, the migration MUST hand back the seats of their live
  departure lines, exactly as a cancellation does. A live line is one where neither the line nor
  its sale is cancelled.
- **FR-003**: The migration MUST run atomically. It MUST NOT delete or alter any row of another
  user: when such a row names an affiliate, the migration fails as a whole.
- **FR-004**: The sign-in check MUST refuse suspended accounts and MUST NOT carry a role exception.
- **FR-005**: The commission report and its CSV MUST type the seller's role as `admin` or `agent`,
  and MUST label it without a fallback for other values.
- **FR-006**: The constitution MUST NOT describe a refusal of a retired role. It MUST be amended
  through `/speckit-constitution`.

### Key Entities

- **Legacy affiliate** — a `users` row with role `affiliate`. One in prod, one in dev.
- **Their records** — the sales they sold and every row tied to those sales; their cash drops,
  payouts, expenses and reset tokens.
- **Departure seats** — the booked count of each departure, and of each zone on a zoned departure.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In each environment after deploy, a count of users with role `affiliate` returns 0.
- **SC-002**: In each environment, each table's row count before and after differs by exactly that
  environment's affiliate rows in the table above, plus whatever was sold in between. Prod:
  - users −1
  - sales −1
  - sale lines −1
  - ledger rows −2
  - allocations −1
  - timeline events −2
  - ticket links −1
  - cash drops −1
- **SC-003**: Each departure the affiliate sold on shows its booked seats lowered by exactly their
  live seats. In prod that is one departure, 2 seats.
- **SC-004**: The code carries no exception for a role other than admin and agent. Every anchor of
  debt `affiliate-tables` reads `gone`, and the entry closes as `verified`.
- **SC-005**: The full API and app suites, lint and both builds pass.

## Assumptions

- The developer accepts the loss the table above lists. Its main items:
  - prod's July 2026 sales fall by MXN 360.00 and its confirmed cash drops by MXN 300.00;
  - dev loses MXN 11,600.00 of sales.

  The alternatives that kept the money were offered and declined.
- Every departure the affiliates sold on is in the past (June–July 2026). Handing their seats back
  sells nothing new; it keeps each booked count equal to the seats its live sales hold.
- The migration's numbers are read again right before each deploy. The table above is a reading,
  not a constant.
