# Implementation Plan: Delete the legacy affiliate users

**Branch**: `feat/delete-legacy-affiliates` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-delete-legacy-affiliates/spec.md`

## Summary

Migration `0070_delete_legacy_affiliates.sql` finds every user stored with role `affiliate` when it
runs, then works in this order:
1. hands back the departure seats of their live lines, as a cancellation does;
2. deletes their sales, children first;
3. deletes their own cash records;
4. deletes the users.

The same change removes 001's three guards for a stored retired role, and amends constitution III to
match. Pays the rest of debt `affiliate-tables`.

Code cites these decisions as `delete-legacy-affiliates D<n>`.

## Decisions

**D1 — One migration, keyed by the role, not by ids.** `0070` selects
`users WHERE role = 'affiliate'` in every statement. The users table is deleted last, so the
selection stays valid throughout.
*Why*: the same file serves prod (one user), dev (another) and every fresh test database (none),
where it changes nothing. One file applies as one unit (research R3).

**D2 — Seats first, the way a cancellation hands them back** (`folios/handler.ts::applyCancellation`).
A live line is one where neither the line nor its sale is cancelled. Each kind of line goes back
its own way:
- **Plain departure line**: `slots.booked = MAX(0, booked − quantity)`.
- **Zoned departure line**: the same on `slot_zones` (the zone counter is authoritative, US-A64).
  The departure's `booked` and `capacity` are then re-derived from its active zones, as
  `zones.reconcile.ts::reconcileSlotTotals` does.
- **Lodging stay**: deleting its reservation is the release (the POS compensation path does the
  same).

*Why*: a cancelled line already gave its seats back when it was cancelled; counting it again would
free seats that other sales hold. Every departure the affiliates sold on is in the past (research
R1), so this sells nothing new. It keeps each booked count equal to the seats its live sales
hold.

**D3 — Children before parents, each delete explicit.** The sale rows go in this order:
1. payment allocations
2. ledger rows
3. timeline events
4. notifications
5. requests
6. ticket links
7. lodging reservations
8. line extras
9. lines
10. sales

Then their cash drops, payouts, expenses and reset tokens; then the users.
*Why*: SQLite enforces every foreign key on D1. Each child is named, rather than left to an
`ON DELETE` action, so the file reads as the inventory it removes.

**D4 — Fail, never touch another user's row.** The migration reaches rows only through the
affiliate's own sales or their own seller column. Another user's row that names an affiliate keeps
the user's foreign key alive, so the final `DELETE FROM users` fails and the whole file rolls back.
Examples: a payment the affiliate collected on another seller's sale, a drop they reviewed, a sale
they cancelled.
*Why*: deleting another seller's money to make the migration pass would widen the loss beyond what
the developer accepted. Measured: no such row exists in prod or dev (research R1).

**D5 — The sign-in check refuses suspended accounts, and nothing else.** `isRefused` goes. Both of
its call sites go back to `resolved.status === 'suspended'`, as before 001.
*Why*: the role exception existed only for the stored `affiliate` row (retire-affiliates D3).
After D1 no row holds another role, and the code only ever writes `admin` or `agent`.

**D6 — The commission report types the role again.** The API's `CommissionReportRow.role` becomes
`UserRole`, and its CSV label is `ROLE_LABEL[s.role]`. The app's type becomes `'admin' | 'agent'`,
and `ReportsPage` drops `roleLabel` for `ROLE_LABEL[s.role]`.
*Why*: the fallback printed a retired role as stored (retire-affiliates D6). No such role remains to
print.

**D7 — The cash-holder rule keeps its code.** `ne(users.role, 'admin')` (retire-affiliates D5) stays.
Only its comment loses the clause about a retired role.
*Why*: with two roles it means "agents", and it is not a guard of the debt.

**D8 — Constitution III is amended** (PATCH, through `/speckit-constitution`): the sentence about
a user row stored with another role being refused at authentication goes.
*Why*: Governance — where code and constitution disagree, one is amended in the pull request that
needs it.

**D9 — Proof.** `test/retire-affiliates/delete-legacy-affiliates.test.ts` seeds an affiliate with
every kind of row: a plain line, a zoned line, a stay, a cancelled line, a drop, a payout and an
expense. It also seeds an agent selling on the same departures, and a second organization. It then
replays `0070` (`?raw`, the `folio-timeline` S-5 precedent) as one batch and asserts each spec
scenario:
- nothing of the affiliate remains;
- seats are handed back exactly;
- the agent and the other organization are unchanged;
- the foreign-key check is clean;
- a cross-reference makes the batch fail with nothing changed;
- a database without affiliates is unchanged.

`retire-affiliates.test.ts` loses its refusal case and its legacy-money cases (they test the guards
D5/D6 remove). Its 404, `/api/me` and shift-cookie cases stay, seeded without the legacy row.

**D10 — Release: one pull request, the normal path.** Each deploy runs the migration before the code.
Before that, the deployed code (with the guards) runs fine on a database without affiliates.
Afterwards, the new code meets a database with none. No release-order constraint beyond that.
*Why*: unlike 002, nothing deployed depends on what `0070` removes.

## Technical Context

**Language/Version**: SQL (SQLite dialect, Cloudflare D1); TypeScript (ESM), Node 22

**Primary Dependencies**: Hono 4, Drizzle ORM (API); React 19, MUI 9 (app)

**Storage**: Cloudflare D1. One data migration, `0070`; no schema change.

**Testing**: Vitest 4 with `@cloudflare/vitest-pool-workers` (every migration applied to a real
local D1); Vitest + MSW for the app

**Target Platform**: Cloudflare Workers

**Project Type**: web service + web app

**Performance Goals**: the migration touches ~20 rows in prod; no runtime change

**Constraints**: atomic; no other user's row deleted or altered (D4); irreversible by design (spec
Assumptions)

**Scale/Scope**: 1 migration, 5 API source files, 2 app source files, 2 test files, constitution

## Constitution Check

| Principle | Gate | Result |
| --- | --- | --- |
| I. Spec-driven, cited | Spec, plan and tasks under `specs/003-delete-legacy-affiliates/`; decisions numbered; scope boundary names the edited suite | PASS |
| II. Money law | The affiliates' ledger rows are deleted outright, not reversed by signed rows | **Justified below** |
| III. Tenant isolation | No route changes scope. The migration is not a request handler: it scopes every delete through the affiliate's own rows (D4), never across organizations by id. The isolation test proves the other organization is untouched (D9) | PASS |
| IV. The server decides | The report's `role` values are unchanged (`admin`/`agent`); only the type narrows | PASS |
| V. Capacity guarded by the DB | Seats handed back with the cancellation's clamp and zone re-derivation (D2) | PASS |
| VI. Proven where enforced | The migration is replayed on the workerd D1 against seeded rows (D9) | PASS |
| VII. Elegant Field Minimalism | No visual change; the role label reads the same | PASS |
| VIII. Services we do not own | The person's identity in the external auth service is untouched (spec scope) | PASS |
| Additional constraints — migrations | "additive and backward-compatible with the code already deployed": backward-compatible (the deployed code runs fine without affiliates), but it deletes rows | **Justified below** |

Re-checked after design: unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/003-delete-legacy-affiliates/
├── spec.md
├── plan.md        # this file
├── research.md    # the inventory and the D1 behaviour D1–D4 rest on
├── quickstart.md  # how to validate; the reads before and after each deploy
├── checklists/
│   └── requirements.md
└── tasks.md
```

No `data-model.md` or `contracts/`: no entity, column or response field is added or changed.

### Source Code (repository root)

```text
api-turistear/
├── migrations/0070_delete_legacy_affiliates.sql       # new (D1–D4)
├── src/middleware/auth.ts                             # isRefused removed (D5)
├── src/types/context.ts                               # comment (D5)
├── src/db/schema.ts                                   # comment (D5)
├── src/routes/reports/handler.ts                      # role typed, no fallback (D6)
├── src/routes/cash/handler.ts                         # comment (D7)
└── test/retire-affiliates/
    ├── delete-legacy-affiliates.test.ts               # new (D9)
    └── retire-affiliates.test.ts                      # guard cases removed (D9)
app-turistear/src/
├── features/reports/types.ts                          # role typed (D6)
└── pages/ReportsPage.tsx                              # roleLabel removed (D6)
.specify/memory/constitution.md                         # III amended (D8)
```

**Structure Decision**: the existing layout; the only new files are the migration and its test.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Money law — "the ledger is the money truth… every movement is a signed row": the affiliates' ledger rows are deleted, not reversed | The developer chose **"Delete user and their sales"**, knowing it removes MXN 360.00 of sales and MXN 300.00 of confirmed drops from prod's history and reports. A user row cannot go while its sales and drops reference it | **Converting the rows** to suspended agents (keeping every peso) was offered first, as the recommended option, and declined: "all affiliates must be removed". **Reversing each sale** with signed refund rows would keep the user row, so the affiliate would remain |
| Migrations "are additive": `0070` deletes rows | Same decision | No additive form removes a row. Compatibility with the deployed code — what the rule protects — holds (D10). The deletion is irreversible: a mistake cannot be fixed forward, so the rows are counted before and after each deploy (quickstart) |
