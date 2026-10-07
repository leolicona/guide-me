# Research: Delete the legacy affiliate users

## R1 — What the affiliates own, and who else names them (read 2026-10-06)

The reads went through the Cloudflare D1 API against `guideme-db-prod` and `guideme-db`.

**Which columns reference `users`.** From the schema every migration builds (applied in order to a
scratch SQLite):
- `folios`: `agent_id` and six `*_by` columns
- `folio_lines.cancelled_by`
- `folio_payments`: `collected_by`, `verified_by`
- `folio_events.actor_id`
- `folio_requests.resolved_by`
- `cash_drops`: `agent_id`, `reviewed_by`, `ack_resolved_by`
- `payouts`: `agent_id`, `created_by`
- `agent_expenses.agent_id`
- `invitations.invited_by`
- `notifications.sent_by`
- `password_reset_tokens.user_id`

`users` has no other incoming reference. No triggers exist.

**Which tables hang off a sale.**
- `folio_lines`, `folio_line_extras`, `folio_payments`, `folio_payment_allocations`
- `folio_events`, `notifications`, `folio_requests`
- `folio_access_tokens`, `accommodation_reservations`

**Rows per affiliate.** Prod is "Lidia Cruz", dev is "Diana".

| | prod | dev |
| --- | ---: | ---: |
| sales (none cancelled) | 1 | 3 |
| lines (departure seats; no zone, none cancelled) | 1 | 3 |
| ledger rows | 2 | 6 |
| allocations | 1 | 3 |
| timeline events | 2 | 8 |
| ticket links | 1 | 3 |
| cash drops | 1 | 3 |
| extras, notifications, requests, stays, payouts, expenses, reset tokens, invitations | 0 | 0 |
| **another user's row naming them** (events, payments, sale `*_by`, line cancels, drop reviews) | **0** | **0** |

**Departures they hold seats on.** Every one of them is in the past:

| env | departure | booked | affiliate seats |
| --- | --- | --- | --- |
| prod | 2026-07-23 | 25 | 2 |
| dev | 2026-06-25 | 30 | 30 |
| dev | 2026-06-26 | 30 | 30 |
| dev | 2026-07-24 | 1 | 1 |

**Decision**: key the migration by role (D1). Delete through their sales and their own seller
columns only (D4).

**Alternatives considered**: hard-coding the two ids was rejected. It would make the file
environment-specific, and the test could not exercise it.

## R2 — When a line still holds seats

Every path that frees seats stamps `cancelled_at`:
- `applyCancellation` stamps the sale and its lines;
- `cancelBookingLine` stamps the line;
- `rejectPayment` stamps the sale and its live lines;
- the expired-booking sweep stamps the live lines.

Each stamp happens in the same step that hands the seats back. A reschedule moves `slot_id` and
the seats together. So a line holds seats exactly when neither it nor its sale carries
`cancelled_at`, on its current `slot_id`.

On a zoned departure, the zone counter is the truth: `slots.booked` is re-derived from active zones
(`reconcileSlotTotals`).

**Decision**: D2.

## R3 — How D1 applies the file

- **Foreign keys are enforced.** D1 enforces them during migrations as well. Its docs tell you to
  `PRAGMA defer_foreign_keys = true` to violate one temporarily
  (developers.cloudflare.com/d1/reference/migrations, § Foreign key constraints); `0070` does not.
- **The file is atomic.** Wrangler applies a migration file as one unit, and a failure rolls it back
  and leaves it unrecorded. `0069` relied on this too (002 D1).

So a cross-reference makes `DELETE FROM users` fail and nothing of the file stays.

**Decision**: D4 relies on it. The test replays the file as one `batch`, which is atomic on D1, and
asserts both outcomes:
- the clean run;
- the failing run that leaves every row in place.
