import { z } from 'zod'

// US-A21 — total folio cancellation. Only the optional admin note is client-supplied;
// organization_id / status / cancelled_by all come from context (Rules 1 & 3). Zod strips
// unknown keys, so an injected `organizationId`/`cancelled_by` is dropped before the handler.
export const cancelFolioSchema = z.object({
  reason: z.string().trim().min(1).nullable().optional(),
  // D10 — the two withdrawn money flags, declared as `never` so sending either is a 400 rather
  // than a silent no-op. `clawback` (US-A26) and `cancelled_by_company` (US-A71) are gone: a
  // cancellation is priced by the org's ladder and by nothing else.
  //
  // Rejected EXPLICITLY rather than via `.strict()`, which would also start 400-ing the injected
  // `organizationId` that the multitenancy contract says is stripped — the same contract every
  // other route in this codebase relies on. A silently discarded money flag is how an admin comes
  // to believe they made a decision that never took effect; an unknown key is not.
  clawback: z.never().optional(),
  cancelled_by_company: z.never().optional(),
})

export type CancelFolioInput = z.infer<typeof cancelFolioSchema>

// US-T04 — admin rejects a tourist's cancellation request. The note is REQUIRED: the
// tourist reads it in their portal, so a silent rejection is not allowed.
export const rejectCancellationRequestSchema = z.object({
  note: z.string().trim().min(1, 'A resolution note is required'),
})

// US-A23 / US-T05 — confirm the physical cash refund. Exactly one of `pin` (the tourist's
// portal PIN, primary) or `override_note` (lost-link escape hatch) — enforced in the
// handler so the error can be precise. Server-owned fields (refund_status, refunded_by, …)
// never appear here; Zod strips unknown keys.
export const confirmRefundSchema = z.object({
  pin: z.string().trim().min(1).optional(),
  override_note: z.string().trim().min(1).optional(),
})

export type RejectCancellationRequestInput = z.infer<
  typeof rejectCancellationRequestSchema
>
export type ConfirmRefundInput = z.infer<typeof confirmRefundSchema>
