# Bug Assessment: a settled line's stale hold clock still expires its apartado

- **Slug**: settled-line-clock-expiry
- **Created**: 2026-10-16
- **Source**: pasted text. The developer asked to fix "the next bug": the one flagged without
  assessment in the Notes of debt `cron-sweeps-full-scan` (PR #168). No URL was given, so the URL
  trust policy did not apply.
- **Verdict**: valid
- **Severity**: high

## Report (verbatim or summarized)

From `cron-sweeps-full-scan`'s Notes (PR #168), verified there on 2026-10-15:

> **A line's clock is never cleared.** Only `routes/pos/handler.ts::confirmSale` (when the line is
> born) and `routes/pos/reschedule.ts::rescheduleFolio` write `folio_lines.booking_expires_at`. No
> settle path (`settleBooking`, `settleFolioLine`, `verifyPayment`) sets it to null…
> **Not assessed here.** `deriveBookingExpiresAtSql` takes the MIN over live lines' clocks with no
> still-owing filter, so a settled line's past clock counts too. Whether that misreads a mixed
> apartado, for example in `settleBooking`'s `BOOKING_EXPIRED` guard, is a question for
> `/speckit-bug-assess`.

It does misread one, and the assessment found a worse consumer than the one the note named: **the
apartado sweep cancels a line that was already paid in full.**

## Symptom

Take a multi-line apartado where one line was settled in full on its own (`settleFolioLine`, F3)
while a sibling still owes. The settled line keeps its hold clock. Once that clock is in the past,
every reader that takes "the lines' clocks" without asking whether a line still owes treats the
**paid line** as an expired hold:

- **R1 (the sweep, severe).** When the owing sibling's clock passes, the folio becomes due.
  - The sweep picks the lines to cancel from **every live line**. The paid line, whose stale clock
    and departure grace have both passed, is cancelled as `system_expiry` / "Apartado vencido".
  - The customer is sent `booking_expired` for the tour they paid for.
  - Because a cancellation happened, the run `continue`s, so the owing sibling, which is in its
    grace window (stage ②), gets no warning.
- **R2 (settle).** `POST /api/pos/folios/:id/settle` answers `409 BOOKING_EXPIRED` although the only
  owing line's hold has 9 days left. `POST …/lines/:lineId/settle` on that same line succeeds, so
  the two settle paths disagree about the same balance.
- **R3 (the lists and the detail).** The folio's derived `booking_expires_at` is the paid line's
  past clock. The seller's list (and the admin's, through the shared serializer) flags the row
  `overdue: true`, while `overdueFilter` — which drives the Vencidos facet and its count — does not
  count it. The card and its count disagree, which breaks `folioPendingWork.ts`'s "must never
  disagree" (US-A84 S-4).

Expected: a line that owes nothing has no hold. Its clock must not expire, cancel, block or flag
anything.

## Reproduction

Reproduced on 2026-10-16 with a temporary vitest file built from `test/folios/line-settle.test.ts`'s
own fixtures (the S-9 shape), on the local D1. The file was then deleted.

1. **Seed** `seedStage()`: an org with a 30% minimum, a near slot (+3 d) and a far slot (+10 d).
   **Create** `createBooking()`: an apartado with a $1,000 near line and a $500 far line, and a
   $600 deposit.
2. **Settle** the near line in full with `settleLine(near)`, which returns 200. It keeps its clock
   (`1781600400`) and gets its QR.
3. **Age it.** The near line's tour departs: `slot_date` today, `06:00`, so its grace instant has
   passed, and its stale clock is in the past (`now − 3600`).
4. **R1.** Also put the far line's clock in the past (`now − 60`); it departs in 10 days, so it is in
   grace. Run `sweepExpiredBookings(env)`:
   - it returns `{"notified":0,"cancelled":1,"failed":0}`;
   - `near.cancelled_at` is set and `near.cancellation_source = 'system_expiry'`;
   - the outbox holds `booking_expired` for the near line;
   - the far line has no `booking_grace_entered` row; the folio is still `booking`.
5. **R2.** Leave the far line's own clock in the future (`1782205200`, now = `1781438400`).
   - `POST /api/pos/folios/:id/settle` returns `409 {"code":"BOOKING_EXPIRED"}`.
   - `POST …/lines/:far/settle` returns 200.
6. **R3.** Same state as R2. `GET /api/pos/folios` returns the row with
   `{"status":"booking","overdue":true,"booking_expires_at":1781434800}`, which is the near line's
   stale clock.

**Exposure in data**, checked read-only on 2026-10-16:

| Database | Paid lines cancelled by the sweep | Lines cancelled by the sweep | Live settled lines still carrying a clock | Lines ever clocked |
|----------|---:|---:|---:|---:|
| `guideme-db-prod` | **0** | 1 | **0** | 1 |
| `guideme-db` (dev) | **0** | 9 | **0** | 66 |

No line has been harmed yet. The shape needs per-line settles on multi-line apartados, which
production has barely used (one clocked line ever). The bug is latent, and it fires the first time
that shape occurs.

## Suspected Code Paths

- `api-turistear/src/utils/folioStatus.ts::deriveBookingExpiresAtSql`. The folio's hold clock is
  `coalesce(MIN over live lines' clocks, MIN over all lines' clocks)`, with no still-owing condition.
  It feeds `settleBooking`'s guard (`routes/pos/handler.ts`, `BOOKING_EXPIRED`), both list reads
  (`routes/folios/handler.ts::listFolios`, `routes/pos/handler.ts::listAgentFolios` →
  `utils/folioListRows.ts::serializeFolioListRow`'s `overdue`) and the detail
  (`utils/folioDetail.ts`).
- `api-turistear/src/routes/pos/sweep.ts::sweepExpiredBookings`:
  - `liveLines = lineRows.filter((l) => !l.cancelledAt)`, then `lineFacts` and
    `dueLines = lineFacts.filter(nowSec >= expiry && nowSec >= grace)`. A settled line enters
    `dueLines` and is passed to `cancelFolioLinesPriced`.
  - `graceInstant = Math.min(...lineFacts.map((f) => f.grace))`, the release time the stage-②
    warning quotes, also counts settled lines.
  - The `due` query itself is right: it requires a live line that still owes.
- `api-turistear/src/routes/folios/handler.ts::cancelFolioLinesPriced`. It cancels whatever live
  lines it is handed, paid or not. It is correct for a deliberate cancellation and is not the
  defect; it is why R1 has no second line of defence.
- `api-turistear/src/routes/pos/handler.ts::settleFolioLine`. The line's clock is checked before
  `LINE_ALREADY_PAID`. A paid line whose stale clock passed answers `BOOKING_EXPIRED`, the wrong
  409, from the same root.
- `api-turistear/src/routes/pos/reschedule.ts::rescheduleFolio`. Its comment says "each LIVE,
  still-owing line's clock recomputes", but the loop skips only cancelled or slot-less lines, so a
  settled sibling gets a fresh clock written. This is the same root on the write side; it is
  harmless once every reader ignores settled lines.
- **Already correct:** `utils/folioPendingWork.ts::overdueFilter` and the sweep's `due` query both
  require "live AND still owing".

## Root Cause Hypothesis

Confidence: **high**. Reproduced end to end.

Since line autonomy (F3, D5), a line can be paid in full while its folio is still an apartado, and
its hold clock is never cleared. Two readers ask "which lines' clocks count?" and answer "every
live line", where the right answer is "every live line that still owes". Those are the folio clock
derivation and the sweep's per-line selection. `overdueFilter` and the sweep's own `due` query
already use the right predicate, so the code holds two definitions of a live hold, and they
disagree exactly when a settled sibling exists.

## Proposed Remediation

**Preferred**: derive "still holding" at read, everywhere, with the predicate the code already uses
for `overdue`: a line holds while it is live AND
`coalesce(sum(allocations), 0) < line_total`. Nothing is stored. This follows constitution II:
state derives from recorded movements, and a stored "cleared" clock would be a second fact beside
the allocations.

1. **`deriveBookingExpiresAtSql`** becomes a three-step `coalesce`:
   - **(a)** MIN over live, still-owing lines with a clock — new;
   - **(b)** MIN over live lines with a clock — today's first step;
   - **(c)** MIN over all lines with a clock — today's lapsed fallback.

   Only a `booking` folio with a settled sibling changes reading. A `booking` folio always has a
   live owing line, so (a) answers. A paid folio falls to (b), exactly as today, and a lapsed one to
   (c), exactly as today. `settleBooking`, both lists' `overdue` and the detail follow without
   further change.
2. **`sweepExpiredBookings`.** `lineRows` also reads `lineTotal` and the line's allocated sum, and
   `lineFacts` is built only from live lines that still owe. A settled line can then never enter
   `dueLines` nor move `graceInstant`. The email's `lines:` list, which describes the booking, is
   unchanged.
3. **`settleFolioLine`.** Check `LINE_ALREADY_PAID` before the clock, so a paid line is refused for
   being paid, never for a hold it no longer has.
4. **`rescheduleFolio`.** Make the loop do what its comment says: skip lines that no longer owe. That
   needs the allocated sum in its `lineRows`. A settled line then keeps whatever clock it had and no
   new stale one is written.

**Alternatives**:

- **Clear `booking_expires_at` when a line becomes fully allocated**, in the settle paths, in
  `verifyPayment`, and in a backfill migration. Readers would stay as they are. Rejected: it adds a
  write to every path that completes a line, so any future path that forgets it brings the bug
  back. It stores a fact derived from the allocations (constitution II). It also changes what the
  lapsed and paid readings show, for no product reason.
- **Guard `cancelFolioLinesPriced` against paid lines.** That is defence in depth for R1 only and
  leaves R2 and R3. It would also refuse a deliberate admin or agent cancellation of a paid line,
  which is a legitimate, priced operation.

**Files likely to change**:

- `api-turistear/src/utils/folioStatus.ts`
- `api-turistear/src/routes/pos/sweep.ts`
- `api-turistear/src/routes/pos/handler.ts` (`settleFolioLine` only)
- `api-turistear/src/routes/pos/reschedule.ts`
- `api-turistear/test/folios/settled-line-clock.test.ts` (new)

**Tests to add or update**:

- **R1.** After the sweep, the settled line is not cancelled, no `booking_expired` names it, and
  the owing sibling in grace gets its `booking_grace_entered` warning, quoting the owing line's own
  release instant.
- **R1b.** When the owing sibling's own grace instant has also passed, the sweep cancels **only**
  the owing line.
- **R2.** `POST /folios/:id/settle` on the mixed apartado answers 200 and completes the folio.
- **R3.** The seller's list row reads `overdue: false`, with `booking_expires_at` equal to the
  owing line's clock. The admin's `?overdue=true` facet and `/folios/counts` agree with it.
- **Paid line.** `settleFolioLine` on the paid line with a stale past clock answers
  `LINE_ALREADY_PAID`.
- **Reschedule.** Rescheduling the owing line leaves the settled sibling's clock untouched.
- **Lapsed and paid readings unchanged.** The lapsed folio still reads its clock (step c) and a paid
  folio still reads step (b). The existing suites assert both: `line-settle.test.ts` S-9,
  `pos-bookings-sweep.test.ts`, `folio-lifecycle-unification.test.ts`, `pos-bookings-settle.test.ts`,
  `pos-bookings-reschedule.test.ts`, `departure-reminders.test.ts`. They must pass unedited.
- **Cross-org.** A `seedTwoOrgs` case: org B's mixed apartado never moves org A's sweep result or
  readings (CLAUDE.md § Multitenancy).

## Risks & Considerations

- **Query cost.**
  - Step (a) adds one correlated MIN, with an allocation sum per line, inside every list row's
    derived clock. The plan stays indexed: `folio_lines_folio_idx` and
    `folio_payment_allocations_line_only_idx` (BUG-042), so no new full read.
  - The sweep reads one more column per due line.
  - The pinned plans in `test/folios/correlation-indexes.test.ts` must stay green.
- **Money law.** The fix only stops a cancellation that should never happen. No ledger, allocation
  or refund arithmetic changes. The money of a line wrongly cancelled before the fix would need an
  admin to correct it, but there are none (0 in prod and dev).
- **Semantics of `settleBooking`.** With step (a), the folio-level settle is refused only when an
  *owing* line's clock passed, the guard's original meaning. A folio with one owing line expired
  and another not is still refused as a whole, and the per-line settle stays available for the
  unexpired one, as today.
- **The wrong messages already in the outbox** for this shape: none exist (0 rows).
- **Interaction with open work.**
  - PR #168 (`cron-sweeps-full-scan`) records the never-cleared clock as a debt note. This fix does
    not change that debt's exit condition: settled apartados still sit in a clock index's range.
  - `specs/006-devolada-transfer-verification` adds a third sweep on the same trigger, but does not
    touch these lines.

## Open Questions

- [NEEDS CLARIFICATION: should the reminder email's `lines:` list name only the lines still owing?
  Today it lists every line of the folio, settled ones included. That is a wording question, not
  this bug, and it is left as is.]
