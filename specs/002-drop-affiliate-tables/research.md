# Research: Drop the retired affiliate tables

## R1 — The order the drop must follow (measured 2026-10-06)

Two probes, both run before writing the migration:

- **SQLite 3.50 (Node's `node:sqlite`)**, a scratch parent/child pair with foreign keys on:
  `DROP TABLE parent` succeeds; afterwards `INSERT INTO child … (key NULL)` and
  `DELETE FROM child` fail with `no such table: main.parent` (an `UPDATE` that does not touch the
  key succeeds). `ALTER TABLE child DROP COLUMN key` succeeds when the key is declared with a
  column-level `REFERENCES`.
- **The workerd D1 the API tests run on**, with every migration through `0068` applied and a legacy
  row seeded into each of the ten objects (a company, an affiliate user with company and position, an
  operator, an invitation, a sale, its payment and its timeline event all stamped with both): the
  exact statements of `0069`, in its order, run as one batch; afterwards no object in
  `sqlite_master` names an affiliate table or the six columns, every seeded row keeps its other
  values (sale total and customer, payment amount, user role and email), new rows insert into
  `folios`, `folio_payments` and `users`, a timeline event deletes, and `PRAGMA foreign_key_check`
  returns nothing. The same probe confirmed a parent dropped first breaks child inserts in D1 too.

Nothing in the schema blocks `DROP COLUMN` on the six: none is indexed, used by a partial index,
named by a view or a trigger, or part of a key (`sqlite_master` read in the same probe).

**Decision**: one migration — columns, then leaves, then parents (D1). **Alternatives considered**:
nulling the child keys and dropping the tables while keeping the columns (001's first R4) —
rejected: it is the order that stops every sale; the twelve-step table rebuild of four tables —
rejected: unnecessary once `DROP COLUMN` was measured to work.

## R2 — What the deployed code names when 0069 runs

With 001 deployed (D2), the only reference to a dropped object is the service hard-delete's
`DELETE FROM affiliate_commissions` (001 D7). Code older than 001 maps all six columns in Drizzle
and writes them on every sale insert. Hence the release order, and the residual risk recorded in
the plan's Complexity Tracking.
