import { z } from 'zod'

// US-A21 — total folio cancellation. Only the optional admin note is client-supplied;
// organization_id / status / cancelled_by all come from context (Rules 1 & 3). Zod strips
// unknown keys, so an injected `organizationId`/`cancelled_by` is dropped before the handler.
export const cancelFolioSchema = z.object({
  reason: z.string().trim().min(1).nullable().optional(),
  // US-A26 — true → claw back the agent's commission (agent loses it); false (default) →
  // the company absorbs the loss and the agent keeps the commission earned on this folio.
  clawback: z.boolean().optional().default(false),
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
