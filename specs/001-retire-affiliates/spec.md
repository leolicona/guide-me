# Feature Specification: Retire affiliates and affiliate shift operators

**Feature Branch**: `feat/retire-affiliates`

**Created**: 2026-10-06

**Status**: Implemented

**Input**: User description: "Retire the affiliate program and affiliate shift operators. The whole
development around affiliates (role `affiliate`, affiliate companies, per-affiliate commissions,
affiliate invitations, the affiliate portal's curated catalog) and affiliate operators (PIN shift
cashiers, `gm_op` sessions, operator attribution on sales) did not work and is removed from the code
(API and app). Production holds test data only (2 companies, 5 commission rows, 2 invitations, 1
affiliate user with 1 cash sale and 1 drop, 0 operators); the data stays in D1, unread, and nothing
is migrated or dropped in this change." — the developer's request, verbatim in Spanish: *"Todo el
desarrollo relacionado con afiliados y operadores de afiliados no funcionó. Tarea: retirarlo del
código."*

## What is broken, with numbers

The affiliate program (archived specs `docs/affiliates/affiliate-setup-commissions.spec.md`,
`affiliate-portal.spec.md`) and its shift operators (`docs/affiliate-operators/affiliate-operators.spec.md`)
never reached real use. Read on 2026-10-06 against the two D1 databases:

| Data | prod (`guideme-db-prod`) | dev (`guideme-db`) |
| --- | --- | --- |
| Affiliate companies | 2 | 2 |
| Per-affiliate commission rows | 5 | 7 |
| Affiliate invitations | 2 | 2 |
| Users with role `affiliate` | 1 (active) | 1 |
| Shift operators | 0 | 1 |
| Sales stamped with an affiliate company | 1 | 3 |
| Sales / payments / events stamped with an operator | 0 / 0 / 0 | 1 / 1 / 2 |
| Org policies or sale snapshots carrying an affiliate commission share | 0 / 0 | 0 / — |

The prod affiliate user's one sale collected MXN 360.00 in cash and has one cash drop on file.

Meanwhile the feature costs every surface: a third role on every authorization check, a second
session kind (`gm_op`) read before every request, an operator join on every sale list, detail,
payment, timeline and dashboard read, an affiliate arm in the cancellation engine, and ~6,000
lines across both workspaces.

## Scope boundary

In scope: removing the affiliate and shift-operator behaviour from `api-turistear` and
`app-turistear` — routes, roles, sessions, screens, response fields, tests — and amending the
constitution, which names both roles.

Out of scope: the data. No migration runs; the four tables and six columns stay in D1, unread.
Dropping them is registered as debt (`.specify/debt/affiliate-tables/`), because a migration runs
before the code it must stay compatible with and a drop cannot be undone.

The mechanical test — these suites cover paths this change touches (auth, selling, cash, reports,
cancellation, the sale list and detail) and MUST pass **unedited**:

- `api-turistear/test/auth/admin-registration.test.ts`, `agent-invitation.test.ts`,
  `password-recovery.test.ts`
- `api-turistear/test/cash/advanced-cash-collection.test.ts`, `agent-balance-cash-drops.test.ts`,
  `agent-balance-ux-overhaul.test.ts`
- `api-turistear/test/folios/folio-cancellation.test.ts`, `folio-list-search.test.ts`,
  `folio-surface-parity.test.ts`, `line-cancellation.test.ts`, `line-settle.test.ts`
- `api-turistear/test/commissions/service-based-commission.test.ts`
- `api-turistear/test/multitenancy/multitenancy.test.ts`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The product has two roles again (Priority: P1)

An admin opens the app and finds no trace of affiliates: no "Afiliados" entry in the navigation, no
company wizard, no per-affiliate commission editor, no affiliate report. An agent sells exactly as
before. Every address that used to manage affiliates or operators answers "not found".

**Why this priority**: it is the request. Everything else follows from removing the role.

**Independent Test**: sign in as an admin and as an agent; walk the navigation and the account
menu; call each retired address — nothing affiliate-shaped is reachable, and selling, cash and
reports work unchanged.

**Acceptance Scenarios**:

1. **Given** an admin session, **When** the admin opens the navigation and the account menu,
   **Then** no affiliate or operator entry exists, and typing a retired screen's address lands on
   the app's not-found handling.
2. **Given** any session, **When** a client calls an affiliate-management or operator address
   (company list, commissions, invite, report, operator list, operator access link, PIN login),
   **Then** it answers not found.
3. **Given** an agent session, **When** the agent sells, collects and cancels, **Then** commissions
   come from the service (or unit type) exactly as before, with no affiliate branch.

---

### User Story 2 - A leftover affiliate account or shift link opens nothing (Priority: P1)

The one affiliate account in production can no longer use the product. Signing in with it is
refused the way a suspended account is refused today. A saved operator link or an old shift cookie
opens nothing.

**Why this priority**: removing the screens without closing the door would leave a role nobody
designed for walking through routes written for agents.

**Independent Test**: seed a user with the legacy role, sign in, call any authenticated address —
refused as suspended, cookies cleared.

**Acceptance Scenarios**:

1. **Given** a user stored with the legacy `affiliate` role, **When** they make any authenticated
   request, **Then** the API answers `403 ACCOUNT_SUSPENDED` and clears the session cookies.
2. **Given** a browser still holding a shift-operator cookie, **When** it calls the API, **Then**
   the cookie is ignored: with no user session the request is unauthenticated (`401`).
3. **Given** a pending affiliate invitation token, **When** someone opens the invitation link,
   **Then** it is treated as an invalid or expired invitation.

---

### User Story 3 - The money already recorded is never lost (Priority: P2)

The legacy affiliate's cash sale stays in the books: it still counts in the commission report, its
seller's open cash balance stays visible to the admin, who can still collect it or pay it out, and
cancelling that sale prices exactly as it did before. An unsold service that still has an old
affiliate commission row can still be deleted.

**Why this priority**: the ledger is the money truth (constitution II). Retiring a role must not
hide or strand a peso already collected.

**Independent Test**: seed a legacy affiliate seller with a cash sale; read the cash roster and the
commission report; register a collection against them; delete an unsold service that has a legacy
commission row.

**Acceptance Scenarios**:

1. **Given** a legacy affiliate seller with a cash sale in range, **When** the admin reads the
   commission report or exports it, **Then** that seller appears with their figures, labelled with
   their stored role, and no row is dropped.
2. **Given** that seller holds cash, **When** the admin opens cash balances, **Then** the seller is
   in the roster and the admin can register a collection or a payout against them.
3. **Given** an unsold service with a legacy affiliate commission row, **When** the admin deletes
   it, **Then** the delete succeeds and leaves no orphan row.
4. **Given** a sale stamped with an affiliate company, **When** it is cancelled, **Then** the
   commission share is the ladder's agent share — the same number the retired rule produced, since
   no stored ladder carries an affiliate share.

---

### User Story 4 - Sale surfaces stop speaking of operators (Priority: P3)

Sale cards, the sale detail, the timeline, the receipt and the day's dashboard no longer show a
"Vendido por" shift operator, and searching sales no longer matches an operator's name. The
cancellation ladder editor has no affiliate column, the invitation form asks only for name and
password, and the reports have no affiliate filter or company column.

**Why this priority**: presentation follows the removal; nothing breaks if it lags, but every
leftover label is a promise the product no longer keeps.

**Independent Test**: open a sale's detail, its timeline, the sale list search, the dashboard, the
ladder editor, an agent invitation and the reports — no operator or affiliate wording or control.

**Acceptance Scenarios**:

1. **Given** any sale, **When** its list card, detail, timeline, receipt or dashboard row renders,
   **Then** no operator name is shown and the API sends none.
2. **Given** a search term, **When** the seller or the admin searches sales, **Then** the server and
   the client match the same fields — customer, seller, sale reference, service, phone — and
   neither matches an operator name.
3. **Given** the cancellation ladder editor, **When** the admin edits a tier, **Then** only the
   refund share and the agent commission share are offered.

---

### Edge Cases

- A stored cancellation ladder or a sale's snapshot that still carried an affiliate commission share
  parses cleanly; the share is ignored (none exists today in either database).
- A legacy affiliate's open cash drop: the admin settles it through the existing direct collection
  and payout flows; the affiliate cannot act on it themselves (Story 2).
- The dev database's one operator-stamped sale renders as a sale made by its seller, with no
  operator label.
- An organization with no affiliate data sees no change except removed entries and fields.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST know exactly two roles, `admin` and `agent`. A request authenticated
  as any other stored role MUST be refused with `403 ACCOUNT_SUSPENDED` and its session cookies
  cleared.
- **FR-002**: The system MUST NOT expose any affiliate-management, affiliate-report, operator-manager
  or operator-access address; each answers not found.
- **FR-003**: The system MUST NOT read or write a shift-operator session; the identity endpoint
  returns only the user.
- **FR-004**: Invitation acceptance MUST resolve only agent invitations and MUST NOT ask for or store
  a company or a job title.
- **FR-005**: Selling MUST resolve the catalog and commissions identically for every caller (the full
  active catalog; service and unit-type rates), with no per-seller allow-list.
- **FR-006**: Sale list, detail, payment history, timeline, dashboard and the sale response MUST NOT
  carry an operator name; sale search MUST match the same fields on the server and the client, with
  no operator arm.
- **FR-007**: The cancellation ladder MUST carry only `refund_pct` and `agent_commission_pct` per
  tier; a stored document with a retired key MUST still parse.
- **FR-008**: The commission report MUST keep every seller with activity in range — legacy roles
  included — and MUST drop the affiliate company filter and column, in JSON and CSV.
- **FR-009**: The cash roster, payouts and direct collections MUST cover every non-admin user of the
  organization, so a legacy seller's open balance stays visible and settleable.
- **FR-010**: Hard-deleting an unsold service MUST keep removing legacy affiliate commission rows
  that reference it, until those rows' table is dropped.
- **FR-011**: The app MUST remove the affiliate and operator screens, routes, navigation entries,
  role guards, services, types and mock handlers, and its mirror of every changed response
  (constitution IV).
- **FR-012**: No data is migrated, rewritten or dropped by this change.

### Key Entities

- **Legacy affiliate data** — companies, per-affiliate commission rows, affiliate invitations, shift
  operators, and the attribution columns on users, sales, payments and timeline events. Kept in the
  database, unread by the code, until a later change drops it.
- **Legacy affiliate user** — a user row whose stored role is `affiliate`. Refused at sign-in time;
  their sales and cash remain ordinary ledger history under their name.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A search of both workspaces' source (tests excluded) for the affiliate and
  shift-operator concepts finds only the retirement itself: lines that cite a `retire-affiliates`
  decision — the legacy-role refusal, the legacy commission-row cleanup, the schema note naming the
  unmapped data, and the comments recording what left.
- **SC-002**: 100% of the suites listed under *Scope boundary* pass unedited, and the full API and
  app suites, lint and both builds pass.
- **SC-003**: The MXN 360.00 cash sale of the prod affiliate user still appears in the commission
  report and in the cash roster after the change.
- **SC-004**: Zero rows are changed in either database by deploying this change.

## Assumptions

- The developer's statement that the development "did not work" means no organization depends on
  it; the numbers above confirm only test data exists.
- Shift-operator cookies live at most 24 hours; ignoring them needs no cleanup step.
- The archived affiliate specs stay in `leolicona/guide-me-docs` as history; citations to them that
  survive in code (none should) would resolve there.
