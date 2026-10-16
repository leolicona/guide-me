# Bug Fix: a settled line's stale hold clock still expires its apartado

- **Slug**: settled-line-clock-expiry
- **Fixed**: 2026-10-16
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Every reader of a line's hold clock now counts only the lines that still **hold**: live, and still
owing (`coalesce(sum(allocations), 0) < line_total`). That is the predicate `overdueFilter` and the
sweep's `due` query already used. Nothing is stored, and no clock is cleared.

Concretely:

- the folio's derived clock reads its owing lines first;
- the sweep picks the lines to cancel, and the release instant it warns about, from owing lines
  only;
- a paid line is refused for being paid before its clock is checked;
- the reschedule neither re-stamps a paid line's clock nor lets a paid line's departure close the
  apartado.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `api-turistear/src/utils/folioStatus.ts` | modified | `deriveBookingExpiresAtSql` is now a three-step `coalesce`: (a) live and still owing, which is new; (b) live, today's first step; (c) all lines, today's lapsed fallback |
| `api-turistear/src/routes/pos/sweep.ts` | modified | `lineRows` reads `lineTotal` and the line's allocated sum. `lineFacts` (and therefore `dueLines` and `graceInstant`) is built from `holdingLines`, the live lines that still owe |
| `api-turistear/src/routes/pos/handler.ts` | modified | `settleFolioLine` checks `LINE_ALREADY_PAID` before the line's clock |
| `api-turistear/src/routes/pos/reschedule.ts` | modified | The re-clock loop skips lines that no longer owe. The `NOT_RESCHEDULABLE` release-instant guard reads only the departures of held lines (scope expansion, see Deviations) |
| `api-turistear/test/folios/settled-line-clock.test.ts` | added test | 7 cases, built on `line-settle.test.ts`'s S-2 cart |

## Diff Highlights

The new first step of the folio clock:

```sql
(select min(fl.booking_expires_at) from folio_lines fl
  where fl.folio_id = folios.id and fl.cancelled_at is null and fl.booking_expires_at is not null
    and coalesce((select sum(a.amount) from folio_payment_allocations a where a.folio_line_id = fl.id), 0) < fl.line_total),
```

The sweep's selection:

```ts
const holdingLines = lineRows.filter(
  (l) => !l.cancelledAt && Number(l.allocated ?? 0) < l.lineTotal,
)
const lineFacts = holdingLines.map((l) => { /* expiry, grace — unchanged */ })
```

## Tests Added or Updated

All in `test/folios/settled-line-clock.test.ts`. The shared shape: the near line is settled in
full, departed at 06:00 today, and its never-cleared clock is an hour old; the far line still owes
and departs in 10 days.

- **R1.** The far line's clock is past, so it is in grace.
  - The sweep cancels nothing.
  - No `booking_expired` names the paid line.
  - The far line gets its `booking_grace_entered` row, the warning the false cancellation used to
    swallow.
- **R1b.** The far line's own grace instant also passes. The sweep cancels **only** the far line,
  and `booking_expired` names only it.
- **R2.** `POST /api/pos/folios/:id/settle` answers 200 and the folio becomes `paid`. Before the
  fix: `409 BOOKING_EXPIRED`.
- **R3.** Three readings agree, in both directions: the seller's list row `overdue`, the admin's
  `?overdue=true` facet, and `/folios/counts.overdue`.
  - Inside the far line's hold, all three read not overdue, and the row's `booking_expires_at` is
    the far line's clock.
  - Once the far clock passes, all three read overdue.
- **Paid line.** `settleFolioLine` on the paid line answers `LINE_ALREADY_PAID`, not
  `BOOKING_EXPIRED`.
- **Reschedule.** Moving the far line answers 200 (before the fix: `409 NOT_RESCHEDULABLE`). The
  paid line's clock is untouched, and the far line's own clock recomputes.
- **Multitenancy.** Two orgs, each with the R1 shape, are swept together. Neither paid line is
  cancelled, and each org's warning row carries its own `organization_id`.

## Local Verification

- **The new test on the fix.** `npx vitest run test/folios/settled-line-clock.test.ts`: 7 passed.
- **The new test on unfixed `main`** (`4b84840`), run in a temporary worktree: **7 of 7 fail**. Every
  case reproduces the bug before the fix.
- **Baseline before the change.** The suites the assessment requires unedited (`line-settle`,
  `pos-bookings-sweep`, `folio-lifecycle-unification`, `pos-bookings-settle`,
  `pos-bookings-reschedule`, `departure-reminders`, `correlation-indexes`): 7 files, 83 tests passed.
- **The full API suite.** `pnpm test:api`: **81 files, 1,018 tests passed**. That is 1,011 plus the
  7 new ones; no existing test file was edited. `correlation-indexes.test.ts` (BUG-042) still pins
  the list row's derived clock to indexed correlations with the new step included.
- **The build.** `pnpm build:api`: built.
- **Types.** `npx tsc --noEmit`, diffed against `main` with line numbers ignored: no new error in
  `src/`. The 8 new lines are all in the new test file and are the repo-wide `cloudflare:test`
  typing class (`env`/`SELF` not exported, implicit `any` on `results`). CI does not type-check the
  API.

## Deviations from Assessment

1. **Scope expanded to the reschedule's `NOT_RESCHEDULABLE` guard.** The assessment did not list it.
   - The reschedule test exposed it: the guard computed the folio's release instant from the
     earliest departure of **every** line, including the settled one that departed this morning and
     even cancelled lines. Moving the far line, which still holds for ten days, was refused with
     "El apartado ya llegó a su instante de liberación".
   - It is the same root (a line that holds nothing defining the apartado's hold), so the fix
     applies the same predicate.
   - The guard's own comment speaks of "the line's release instant"; the folio-wide minimum over
     held lines keeps its existing shape for every apartado without a settled or cancelled
     sibling.
2. **The reschedule test asserts the far line's own clock recomputed, not only that the paid
   line's clock was left alone.** This proves the loop still re-clocks the lines that hold.

## Follow-ups

- **The reminder email's `lines:` list still names every line of the folio**, settled ones
  included. This is the assessment's open question; it is a wording decision, unchanged here.
- **`cron-sweeps-full-scan` (PR #168).** Its note that a line's clock is never cleared still holds:
  no clock is cleared here, by design. Its exit condition is unaffected. The "Not assessed here"
  note in that entry can point to this bug once both are on `main`.
- **Data.** No line was harmed: 0 paid lines cancelled by the sweep, and 0 live settled lines
  carrying a clock, in both prod and dev (read-only, 2026-10-16). There is nothing to repair.
