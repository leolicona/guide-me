# Bug Assessment: The reminder template edited in Ajustes is never used

- **Slug**: wa-reminder-template-unused
- **Created**: 2026-11-03
- **Source**: pasted text — `specs/006-devolada-transfer-verification/research.md:632`, § Defects found on the way, defect 8 (T077)
- **Verdict**: valid
- **Severity**: low

## Report (verbatim or summarized)

> 8. `wa_reminder_template` is edited in Ajustes but never read. `app:features/bookings/components/BookingWhatsAppButton.tsx:39-51`.

## Symptom

An admin edits the apartado reminder in Ajustes and saves it; the seller's «Recordar por WhatsApp» still sends a hard-coded text. Expected: the button renders the organization's template (or the default when none is saved), as the ticket message already does with `wa_ticket_template`.

## Reproduction

1. Ajustes → WhatsApp → change the reminder template, save.
2. Open an apartado with a balance and tap the reminder button.
3. Observed: the `wa.me` text is the hard-coded sentence, not the saved template.

## Suspected Code Paths

- `app-turistear/src/features/bookings/components/BookingWhatsAppButton.tsx:42-50` — builds the text inline («Hola …, te escribe … Te recordamos que tu apartado tiene …»).
- `app-turistear/src/features/pos/delivery.ts:53-54` — `DEFAULT_REMINDER_TEMPLATE`, used only by Ajustes.
- `app-turistear/src/pages/SettingsPage.tsx:171, 279, 284` — reads and saves `wa_reminder_template`.
- `api-turistear/src/db/schema.ts:54`, `api-turistear/src/routes/organizations/handler.ts:38` — stored and returned.

## Root Cause Hypothesis

The template setting shipped with the editor and the default, but the button was never switched to render it. Confidence: high.

## Proposed Remediation

**Preferred**: Render the reminder through the same placeholder renderer the ticket message uses (`delivery.ts`), with `org.wa_reminder_template ?? DEFAULT_REMINDER_TEMPLATE` and the placeholders `{customer_name}`, `{agent_name}`, `{org_name}`, `{pending_balance}`.

**Files likely to change**:
- `app-turistear/src/features/bookings/components/BookingWhatsAppButton.tsx`
- `app-turistear/src/features/pos/delivery.ts` (if the renderer needs a reminder variant)
- the button's test

**Tests to add or update**:
- Saved template → the `wa.me` text is the rendered template.
- No template → the default.

## Risks & Considerations

- The default template's wording differs from today's hard-coded text; organizations that never edited it will see the default's wording.

## Open Questions

- None.
