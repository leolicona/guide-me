# Bug Verification: a settled line's stale hold clock still expires its apartado

- **Slug**: settled-line-clock-expiry
- **Tested**: 2026-10-16
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The assessment's reproduction was run again, unchanged, on the fixed code (`f780ace`), and all three
symptoms are gone:

- the sweep no longer cancels the paid line, and warns the owing one instead;
- the whole-folio settle answers 200;
- the list row no longer reads overdue.

The new test fails 7 of 7 on unfixed `main` and passes 7 of 7 on the fix. The full API suite passes
with no existing test edited. No regressions were found.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Reproduction (post-fix) | The assessment's own temporary reproduction file, R1–R3, unchanged. It was run on `f780ace`, then deleted | pass | R1: sweep `{"notified":0,"cancelled":0,"failed":0}`, paid line not cancelled, `booking_grace_entered` written. R2: `settleBooking` 200, folio `paid`. R3: row `overdue:false`, `booking_expires_at` = the owing line's clock |
| New test, fixed code | `npx vitest run test/folios/settled-line-clock.test.ts` | pass | 7 / 7 |
| New test, unfixed `main` | The same file run in a temporary worktree at `4b84840` | fail (expected) | 7 / 7 fail. The test detects the bug |
| Suites the assessment requires unedited | `line-settle`, `pos-bookings-sweep`, `folio-lifecycle-unification`, `pos-bookings-settle`, `pos-bookings-reschedule`, `departure-reminders`, `correlation-indexes`, plus the new file | pass | 8 files, 90 tests. Before the fix, the same 7 suites: 83 tests |
| Regression suite | `pnpm test:api` | pass | 81 files, 1,018 tests. `git diff origin/main..HEAD -- api-turistear/test` touches only the new file |
| Build | `pnpm build:api` | pass | — |
| Type-check | `npx tsc --noEmit`, diffed against `main` with line numbers ignored | pass | No new error in `src/`. The 8 new lines are the repo-wide `cloudflare:test` typing class, all in the new test file |
| App lint / tests | `pnpm lint:app`, `pnpm test:app` | skipped | The branch changes nothing under `app-turistear/` |
| CI `verify` | GitHub Actions on a pull request | not-run | No pull request is open yet |
| Production behaviour | — | not-run | Not part of the assessment's reproduction, which was local. Production holds no instance of the shape: 0 live settled lines carrying a clock, and 0 paid lines ever cancelled by the sweep (read-only, 2026-10-16) |

## Output Excerpts

The reproduction, before the fix (from the assessment) and after it:

```text
before  R1 sweep: {"notified":0,"cancelled":1,"failed":0} near.cancelled_at=1781438400 near.source=system_expiry … booking_expired(near)
after   R1 sweep: {"notified":0,"cancelled":0,"failed":0} near.cancelled_at=null      near.source=null          … booking_grace_entered

before  R2 settleBooking: 409 {"error":{"code":"BOOKING_EXPIRED","message":"Booking has expired"}}
after   R2 settleBooking: 200 {"folio":{… "status":"paid" …}}

before  R3 list row: {"status":"booking","overdue":true, "booking_expires_at":1781434800,"now":1781438400}
after   R3 list row: {"status":"booking","overdue":false,"booking_expires_at":1782205200,"now":1781438400}
```

In R2, after the fix, the follow-up `settleFolioLine(far)` answers
`409 ALREADY_SETTLED "Folio is already paid"`. That is correct: the whole-folio settle had just paid
it.

Test runs:

```text
 Test Files  1 passed (1)   Tests  7 passed (7)        # settled-line-clock, fixed code
      Tests  7 failed (7)                              # settled-line-clock, unfixed main (4b84840)
 Test Files  8 passed (8)   Tests  90 passed (90)      # new + the seven unedited suites
 Test Files  81 passed (81) Tests  1018 passed (1018)  # pnpm test:api
```

## Residual Risks

- **Read cost.** The folio's derived clock gains one correlated MIN, with an allocation sum, per
  list row. It stays indexed: `correlation-indexes.test.ts` still pins the list row's correlations
  to `folio_lines_folio_idx` and `folio_payment_allocations_line_only_idx`. It is a constant per
  row, not a new full read.
- **Untested combination.** A `booking` folio whose owing line has a NULL clock (legacy) and a
  settled sibling with a clock falls through to step (b) and still reads the sibling's clock, as
  before. No current data has this shape, and the sweep's `due` query never selects such a line
  either.
- **The reminder email's `lines:` list** still names settled lines too. This is the assessment's
  open question, deliberately unchanged.
- **Not seen in a real environment yet.** The fix is verified locally only; CI and the preview have
  not run. Production cannot exhibit the before/after, because it has no folio of this shape.

## Recommendation

Close the bug: it is verified end to end against the assessment's own reproduction, and the new
test fails without the fix. Open the pull request, so `verify` and the preview run on it.
