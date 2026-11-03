# Bug Assessment: A full sale by transfer queues «envía los boletos» before anyone verified the money

- **Slug**: pending-sale-queues-tickets
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:630`, § Defects found on the way, defect 6 (T077)
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

> 6. A pending full transfer sale enqueues a `tickets_delivered` WhatsApp row at checkout. `routes/pos/handler.ts:1953-1958`.

## Symptom

`confirmSale` emits `tickets_delivered` for every non-apartado sale, including a full sale whose transfer is still `pending` and has no QR yet. The WhatsApp outbox then asks the seller to send tickets that do not exist; marking it sent stamps `tickets_sent_at`. When the transfer is verified later, `releaseClearedFolio` emits `tickets_delivered` again, but `uq_notifications_folio_event_channel` swallows it (`onConflictDoNothing`), so the real delivery never gets its own row. Expected: a pending sale queues no ticket message; the verification queues it.

## Reproduction

1. Sell a full sale by transfer with a reference (organization without Devolada, or with Devolada: the link is issued after this emit).
2. Observed: a `notifications` row `event = 'tickets_delivered'`, `channel = 'whatsapp'`, `status = 'pending'`, while `payment_verification = 'pending'`.
3. Verify the transfer: no new row is written.

## Suspected Code Paths

- `api-turistear/src/routes/pos/handler.ts:1978-1986` — `event: isBooking ? 'booking_created' : 'tickets_delivered'`, with no check of `cleared` / verification.
- `api-turistear/src/utils/notifications.ts:145-180` (`emitNotification`) — `onConflictDoNothing` on the unique `(folio, event, channel)`.
- `api-turistear/src/routes/pos/verifyCore.ts:270` and `api-turistear/src/routes/pos/settleCore.ts:471` — the later emits that the conflict swallows.
- `api-turistear/src/routes/notifications/handler.ts:89-150` (`markNotificationSent`) — draining it stamps `folios.tickets_sent_at` (D26).

## Root Cause Hypothesis

The US-A86 action-tail assumed every non-apartado sale is cleared at checkout; transfer verification (US-A67) made "paid but pending" possible and the emit was not narrowed. Confidence: high for the enqueue; medium for how the seller's card and the outbox present the row [NEEDS CLARIFICATION below].

## Proposed Remediation

**Preferred**: Emit `tickets_delivered` at checkout only when the sale is cleared (the same `cleared` flag that decides the email and the QR, `handler.ts:1937`). A pending full sale emits nothing at checkout; `releaseClearedFolio` (Verificar, Devolada's verdict) emits it once the money is verified, and the unique index then works as intended.

**Files likely to change**:
- `api-turistear/src/routes/pos/handler.ts`
- a new or existing notifications suite (e.g. `api-turistear/test/notifications/*.test.ts`)

**Tests to add or update**:
- Pending full transfer sale → no `tickets_delivered` row; verification → one row.
- Cash sale → unchanged (one row at checkout).

## Risks & Considerations

- Existing pending rows for unverified sales stay in production outboxes; decide whether to delete them or leave them.

## Open Questions

- [NEEDS CLARIFICATION: does the seller's card rung or the outbox already hide this row while the sale is pending? The enqueue is confirmed; what the seller sees was not reproduced.]
