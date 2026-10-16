# Bug Fix: customer messages say «folio», and the outbox sends them with holes

- **Slug**: payment-rejected-folio-copy
- **Fixed**: 2026-10-16
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Three customer messages said «folio»: the approved cancellation, the rejected payment and the
completed refund. They now say «tu compra en {organización}». The outbox no longer cuts what it
cannot fill: the server fills each row's message from its own sale and returns it as `message`,
and the WhatsApp composer sends it as is. The refund receipt the admin sends from a sale's detail
says the same sentence the outbox does.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `api-turistear/src/utils/notifications.ts` | modified | `cancellation_approved`, `payment_rejected` and `refund_completed` say «tu compra en {org_name}». New `renderOutboxMessage(template, values)` fills every placeholder in one pass. `readOutbox` also reads the organization (name, zone), the seller and the sale's figures. The credit sentence moved into `creditClause`, which `renderFigures` shares |
| `api-turistear/src/routes/notifications/handler.ts` | modified | the outbox read returns `message`, beside `template` |
| `api-turistear/test/folios/notification-outbox.test.ts` | added tests | five cases (below) |
| `app-turistear/src/features/folios/hooks/useOutbox.ts` | modified | `OutboxRow.message` |
| `app-turistear/src/pages/OutboxPage.tsx` | modified | the composer sends `row.message`; the old fill stays only as a fallback for a row without one |
| `app-turistear/src/pages/OutboxPage.test.tsx` | added test | the server's message is shown and sent verbatim |
| `app-turistear/src/features/folios/refundReceipt.ts` | modified | «confirmamos el reembolso de tu compra en {org}», taking the organization's name |
| `app-turistear/src/features/folios/components/FolioDetailScreen.tsx` | modified | passes the organization's name to the receipt |
| `app-turistear/src/features/folios/refundReceipt.test.ts` | modified | the old «names the folio» case now asserts «tu compra en {org}» and no «folio» |

## Diff Highlights

```ts
// One pass: a value is never read again as a placeholder.
return template
  .replace(/\{([a-z_]+)\}/g, (_, key: string) => values[key] ?? '')
  .replace(/\s+/g, ' ')
  .trim()
```

```ts
payment_rejected:
  'Hola {customer_name}, no pudimos confirmar el pago de tu compra en {org_name}, ' +
  'así que tuvimos que cancelarla. Si crees que es un error, escríbeme. — {agent_name}',
```

## Tests Added or Updated

- `notification-outbox.test.ts`, «a rejected payment names the organization and is signed by the
  seller»: the exact message, with the organization and the seller filled in.
- «an approved cancellation names the organization».
- «a completed refund spells out what was paid, returned and kept»: $2,000.00 paid, $1,500.00
  returned and $500.00 kept, from the sale's lines.
- «each organization's message names its own organization»: `seedTwoOrgs`, constitution III.
- «no shipped template says «folio», and a value is never read again as a placeholder».
- `OutboxPage.test.tsx`, «shows and sends the message the server filled».
- `refundReceipt.test.ts`, «names the purchase and the organization, never «folio»».

## Local Verification

- **API, notifications and around them:** `pnpm exec vitest run test/folios/notification-outbox.test.ts test/folios/line-cancellation.test.ts test/pos/payment-verification.test.ts` → 3 files, 33 tests passed.
- **API types:** `pnpm exec tsc --noEmit -p tsconfig.json` → 332 errors under `src`, the
  pre-existing baseline (defect 9). The seven in `routes/notifications/handler.ts` predate this
  fix; they only moved down by the lines added.
- **App:** `pnpm exec vitest run src/features/folios/refundReceipt.test.ts src/features/folios/components/FolioDetailScreen.test.tsx src/pages/OutboxPage.test.tsx` → 3 files, 35 tests passed.
- **App types and lint:** `pnpm exec tsc -b` → clean; `eslint` on the six app files → clean.

## Deviations from Assessment

- **Placeholders that stay dropped.** `{itinerary}` and `{portal_link}` are still dropped from
  `tickets_delivered`, `departure_reminder` and `review_requested`, never sent raw. They need the
  sale's lines and a signed ticket token, which only the delivery screens compose (D26). The three
  messages this bug names do not use them.
- **What is now filled.** `{booking_expires_at}`, `{pending_balance}` and `{total}` are filled
  from the sale, so `booking_created`, `payment_verified` and `booking_grace_entered` also arrive
  whole.
- **The `template` field.** `template` stays in the outbox read beside `message`. The app ships
  with the API, but keeping it costs nothing, and a cached client keeps working.

## Follow-ups

- **`{itinerary}` in the outbox:** render it on the server too, once a reader of a sale's lines for
  messages exists. Then `departure_reminder` and `review_requested` arrive whole from the outbox.
- **Admin copy:** `CancellationPolicyCard.tsx:271` says «servicio del folio». That is admin
  copy, the same constitution VII rule, and outside this fix.
