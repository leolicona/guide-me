# Feature Specification: Drop the retired affiliate tables

**Feature Branch**: `feat/drop-affiliate-tables` (stacked on `feat/retire-affiliates`)

**Created**: 2026-10-06

**Status**: Implemented

**Input**: the developer, after `specs/001-retire-affiliates`: *"Se arreglan por fuera, procede con
la limpieza."* — the legacy affiliate user and its open cash are settled outside the product; drop
what 001 left in the database. Pays debt `affiliate-tables`.

## What is broken, with numbers

`specs/001-retire-affiliates` removed the code but deliberately left the data (its D1): four tables
and six nullable foreign-key columns, unread. On 2026-10-06 prod held 2 companies, 5 commission
rows, 2 invitations and 0 operators; 1 sale carried an `affiliate_company_id`. The code still names
one of the tables — the service hard-delete clears legacy commission rows through a local mapping
(001 D7) — and `schema.ts` carries a note listing all ten objects so nobody re-maps them.

001's research (R4, corrected in build) measured what the drop must respect: a parent table
dropped while a child still declares `REFERENCES` to it makes every `INSERT` or `DELETE` on that
child fail with `no such table` — even with the key `NULL`. Done in the wrong order, this cleanup
stops every sale.

## Scope boundary

In scope: one migration that drops the six columns and the four tables; removing the code and test
fixtures that name them.

Out of scope: the `users` row still stored with role `affiliate` and its MXN 360.00 sale and drop —
the developer settles them outside the product, so 001's guards for a stored retired role (D3
refusal, D5 cash holders, D6 report label) stay. No app change.

The mechanical test — every API suite passes, and all of them except these three pass **unedited**:
`test/retire-affiliates/retire-affiliates.test.ts` (it seeded the dropped objects),
`test/catalog/service-hard-delete.test.ts` (one comment named the cleanup),
`test/folios/folio-timeline.test.ts` (it replays migration 0061, which names a dropped column).
Every app suite passes unedited.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The database holds nothing of the retired program (Priority: P1)

After migrating, no affiliate table, index or column exists, and no foreign key points at a table
that is gone. Selling, collecting, cancelling and inviting keep writing exactly as before, and no
row of users, sales, payments or timeline events is lost.

**Why this priority**: it is the request, and its one failure mode stops every sale.

**Independent Test**: on a database with every migration applied, list the schema and the foreign
keys of every table; insert and delete a sale, a payment and a timeline event.

**Acceptance Scenarios**:

1. **Given** a database migrated to the latest version, **When** its schema is listed, **Then** it
   has no `affiliate_*` table or index and none of the six columns.
2. **Given** that database, **When** every table's foreign keys are listed, **Then** each one names
   a table that exists.
3. **Given** that database, **When** a sale, its payment and its timeline event are inserted and then
   deleted, **Then** every statement succeeds and the foreign-key check is clean.
4. **Given** a database holding legacy rows in every retired object, **When** the migration runs,
   **Then** it succeeds atomically and every row of `users`, `folios`, `folio_payments` and
   `folio_events` keeps all its other values.

---

### User Story 2 - The code names nothing that is gone (Priority: P2)

Deleting an unsold service no longer touches an affiliate table, and the schema carries no note
about objects that no longer exist.

**Why this priority**: once the table is gone, the 001 cleanup statement would fail every hard
delete.

**Independent Test**: hard-delete an unsold service with slots, schedules and extras.

**Acceptance Scenarios**:

1. **Given** an unsold service, **When** the admin deletes it, **Then** it and its slots, schedules
   and extras are gone and the request succeeds.

### Edge Cases

- The migration runs while 001's code is deployed (the release order below): the only statement
  that code still sends to a dropped object is the service hard-delete's cleanup; during the
  seconds between the migration and the new deploy, a hard-delete answers an error and writes
  nothing (its batch is atomic), and succeeds on retry.
- The migration runs while code **older** than 001 is deployed: every sale fails until the deploy,
  because that code writes the dropped columns. The release order forbids it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: One migration MUST drop the six child columns before any of the four tables, and the
  tables leaves before parents.
- **FR-002**: The migration MUST run atomically and MUST NOT change any other column or row.
- **FR-003**: After migrating, every foreign key in the schema MUST reference an existing table.
- **FR-004**: The code MUST NOT name any dropped object; the service hard-delete MUST keep removing
  slots, slot zones, schedules, service zones and extras.
- **FR-005**: The change MUST reach production only after the release carrying
  `specs/001-retire-affiliates` is deployed there.

### Key Entities

- **Retired objects** — `affiliate_companies`, `affiliate_commissions`, `affiliate_invitations`,
  `affiliate_operators`; `users.affiliate_company_id`, `users.position`,
  `folios.affiliate_company_id`, `folios.operator_id`, `folio_payments.operator_id`,
  `folio_events.operator_id`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In each environment after deploy, a schema listing returns zero objects named
  `affiliate%` and none of the six columns.
- **SC-002**: The row counts of `users`, `folios`, `folio_payments` and `folio_events` are the same
  before and after the migration in each environment.
- **SC-003**: The full API and app suites, lint and both builds pass.
- **SC-004**: The code contains no reference to an `affiliate_` table.

## Assumptions

- The developer settles the legacy affiliate user and its cash outside the product (their words:
  *"se arreglan por fuera"*); the migration does not touch `users.role`.
- Losing the retired rows is accepted: they are test data (001's numbers), and the developer asked
  for the cleanup knowing it.
