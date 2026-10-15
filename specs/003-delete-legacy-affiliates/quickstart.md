# Quickstart: validate the deletion

## Before merging

```bash
pnpm lint:app && pnpm test:app && pnpm test:api && pnpm build:api && pnpm build:app
pnpm --filter api-turistear exec vitest run test/retire-affiliates   # D9
grep -rnE "isRefused|\?\? s\.role|\?\? role\b" api-turistear/src app-turistear/src   # → none (SC-004)
```

The API suite applies every migration, `0070` included, to a fresh local D1. There it changes
nothing: no affiliate exists.

## Baseline — before `0070` (read 2026-10-06 17:17 UTC), and what each deploy must leave

| DB | users | sales | lines | ledger | allocations | events | ticket links | drops | affiliate seats' departures (booked) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| prod, before | 10 | 1,009 | 1,044 | 1,420 | 1,048 | 3,826 | 1,005 | 16 | 25 |
| prod, expected after | 9 | 1,008 | 1,043 | 1,418 | 1,047 | 3,824 | 1,004 | 15 | 23 |
| dev, before | 11 | 642 | 653 | 1,541 | 819 | 1,662 | 428 | 43 | 30 · 30 · 1 |
| dev, expected after | 10 | 639 | 650 | 1,535 | 816 | 1,654 | 425 | 40 | 0 · 0 · 0 |

"Expected after" assumes nothing is sold in between. A new sale adds its own rows on top of these
numbers.

## In each environment — right before and right after its deploy (SC-001 – SC-003)

Run each read through `wrangler d1 execute guideme-db --remote --env dev --command "…"`, or
`guideme-db-prod --env production` for prod.

### The affiliates and what they own

Before the deploy, this must match research R1, plus anything sold since. After the deploy, it must
be all zeros.

```sql
WITH u AS (SELECT id FROM users WHERE role = 'affiliate'),
     f AS (SELECT id FROM folios WHERE agent_id IN (SELECT id FROM u))
SELECT (SELECT count(*) FROM u) users,
       (SELECT count(*) FROM f) sales,
       (SELECT count(*) FROM folio_lines WHERE folio_id IN (SELECT id FROM f)) lines,
       (SELECT count(*) FROM folio_payments WHERE folio_id IN (SELECT id FROM f)) ledger,
       (SELECT count(*) FROM folio_events WHERE folio_id IN (SELECT id FROM f)) events,
       (SELECT count(*) FROM cash_drops WHERE agent_id IN (SELECT id FROM u)) drops;
```

### Table totals

After the deploy, each total must be lower than before by exactly the counts above, plus whatever
was sold in between.

```sql
SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM folios) folios,
       (SELECT count(*) FROM folio_lines) lines, (SELECT count(*) FROM folio_payments) ledger,
       (SELECT count(*) FROM folio_payment_allocations) allocations,
       (SELECT count(*) FROM folio_events) events, (SELECT count(*) FROM folio_access_tokens) tokens,
       (SELECT count(*) FROM cash_drops) drops;
```

### Seats

Read before the deploy. After it, `booked` must be lower by exactly `affiliate_seats`, never below
zero.

```sql
SELECT s.id, s.date, s.booked,
       (SELECT sum(l.quantity) FROM folio_lines l JOIN folios f ON f.id = l.folio_id
         WHERE l.slot_id = s.id AND l.cancelled_at IS NULL AND f.cancelled_at IS NULL
           AND f.agent_id IN (SELECT id FROM users WHERE role = 'affiliate')) affiliate_seats
FROM slots s
WHERE s.id IN (SELECT l.slot_id FROM folio_lines l JOIN folios f ON f.id = l.folio_id
               WHERE f.agent_id IN (SELECT id FROM users WHERE role = 'affiliate'));
```

Prod: `PRAGMA foreign_key_check` must return no rows after the deploy.

Then close the debt with `/speckit-debt-pay affiliate-tables`.
