# Bug Fix: "Verificar y enviar" sends the ticket message with no link on an apartado

- **Slug**: verify-send-empty-link
- **Fixed**: 2026-10-06
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

`Verificar y enviar` now branches on the verified folio: an apartado (`status = 'booking'`) gets a
deposit-confirmation WhatsApp and is **not** marked sent; a paid folio keeps the ticket message. The
ticket-link builder refuses an empty portal link, and both mark-sent endpoints refuse (`409`) a
folio with no portal token, so the false "Enviado" can no longer be recorded by any client.

Open question resolved by the developer (2026-10-06): **option A**, the deposit-confirmation text.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `app-turistear/src/features/folios/components/VerifyAndSendButton.tsx` | modified | `status === 'booking'` → `depositVerifiedWhatsAppUrl`, toast *Anticipo verificado*, no `markSent`. Paid path unchanged. |
| `app-turistear/src/features/pos/delivery.ts` | modified | `ticketWhatsAppUrl` returns `null` without a portal link; new `DEPOSIT_VERIFIED_TEMPLATE` + `depositVerifiedWhatsAppUrl`; `{amount_paid}` placeholder; shared private `whatsAppUrl`. |
| `api-turistear/src/utils/portal.ts` | modified | `hasPortalTokenSql` — `exists` over `folio_access_tokens` for the outer `folios` row. |
| `api-turistear/src/routes/pos/handler.ts` | modified | `markTicketsSent` ANDs the guard into its UPDATE; 0 rows → `404` if the folio is out of scope, else `409 CONFLICT`. |
| `api-turistear/src/routes/folios/handler.ts` | modified | `markTicketsSentAdmin`, same guard and same 404/409 split. |
| `app-turistear/src/features/folios/components/VerifyAndSendButton.test.tsx` | added test | Component behaviour for apartado / paid / paid-without-link. |
| `app-turistear/src/features/pos/delivery.test.ts` | updated test | Empty-link refusal; deposit message text and null-phone case. |
| `api-turistear/test/pos/whatsapp-delivery.test.ts` | updated test | 409 on apartado (seller + admin), 409 after a verified transfer on an apartado, 404 still for an unknown folio. |

## Diff Highlights (optional)

```tsx
// VerifyAndSendButton.tsx
if (verified.status === 'booking') {
  setToast('Anticipo verificado')
  const url = depositVerifiedWhatsAppUrl(ctx)
  if (url) window.open(url, '_blank')
  return
}
```

```ts
// pos/handler.ts — markTicketsSent (admin twin is identical)
.where(and(scope, hasPortalTokenSql))
…
if (!row) {
  const exists = await db.select({ id: folios.id }).from(folios).where(scope).limit(1)
  if (!exists[0]) throw new ApiError('NOT_FOUND', 404, 'Folio not found')
  throw new ApiError('CONFLICT', 409, 'This folio has no tickets to deliver yet')
}
```

Deposit message as sent:
> Hola {nombre}, te escribe {agente} de {org}. Confirmamos tu anticipo de $800.00. Tu saldo
> pendiente es $1,700.00; tus boletos se envían al liquidarlo.

## Tests Added or Updated

- `VerifyAndSendButton.test.tsx` › *an apartado gets the deposit confirmation, never the ticket message, and is not marked sent* — the reported bug.
- `VerifyAndSendButton.test.tsx` › *a paid folio still gets the ticket message with its link, and is marked sent* — no regression on the paid path.
- `VerifyAndSendButton.test.tsx` › *a paid folio whose link failed to mint sends nothing and marks nothing* — the best-effort token failure.
- `delivery.test.ts` › *ticketWhatsAppUrl returns null when there is no portal link*.
- `delivery.test.ts` › *depositVerifiedWhatsAppUrl* (exact text, null phone).
- `whatsapp-delivery.test.ts` › *an apartado cannot be marked sent by the seller or the admin (409)*.
- `whatsapp-delivery.test.ts` › *a verified-transfer apartado still has no link and cannot be marked sent (409)* — the reported path end to end on the API.
- `whatsapp-delivery.test.ts` › *an unknown folio is still a 404, not a 409*.

## Local Verification

- Reproduced first: with the source changes reverted, the two new API tests fail (`expected 200 to be 409`) and two of the three component tests fail (the apartado receives *"…Aquí está tu reserva y tus boletos…"*; `window.open` called on the link-less paid folio). With the fix applied, all pass.
- `pnpm lint:app` → 0 errors (7 pre-existing warnings, none in changed files).
- `pnpm test:app` → 47 files, 732 tests passed.
- `pnpm test:api` → 76 files, 997 tests passed.
- `pnpm build:api` → ok; `pnpm build:app` → ok.
- `npx tsc --noEmit -p api-turistear` → 586 errors before and after, identical set (pre-existing `c.req.param` typing); none introduced.
- Manual checks: none in a running app.

## Deviations from Assessment

- **Branch condition.** The assessment's preferred fix keyed the ticket path on `status === 'paid' && portal_link`, everything else to the deposit message. Built instead as `status === 'booking'` → deposit message; everything else → ticket path, which now yields no URL when the link is missing. Reason: a *paid* folio whose portal token failed to mint (best-effort issuance) would otherwise have received "Confirmamos tu anticipo de {total}", which is false. It now sends nothing and stays *Pendiente*.
- **Scope expansion — `{amount_paid}` placeholder.** Added to `fillTemplate`'s map so the deposit message can name the amount. Not added to `TEMPLATE_PLACEHOLDERS` (the settings screen's documented list); an org template that already contains the literal `{amount_paid}` would now be filled instead of left raw.
- **Error code.** The `409` uses the existing `CONFLICT` code rather than a new one; no client branches on it.

## Follow-ups

- Folios mis-stamped *Enviado* while still apartados keep the stamp; after settle their delivery axis reads *Enviado* for tickets never sent. No backfill was done — candidate query: `tickets_sent_at IS NOT NULL` with the earliest `folio_access_tokens.created_at` later than `tickets_sent_at`.
- `FolioWorkActions.tsx:234` signs the admin's ticket send with the **seller's** name (`folio.agent?.name`) while it opens on the admin's phone; `VerifyAndSendButton` signs with the admin's own. Inconsistent, out of scope here.
- Lodging (spec to come): a stay has no QR, so even a correct link lands on a portal with nothing to show at the desk; the apartado hold for a stay runs to check-in 00:00.
