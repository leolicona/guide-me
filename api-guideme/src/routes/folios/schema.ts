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
