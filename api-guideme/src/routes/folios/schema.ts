import { z } from 'zod'

// US-A21 — total folio cancellation. Only the optional admin note is client-supplied;
// organization_id / status / cancelled_by all come from context (Rules 1 & 3). Zod strips
// unknown keys, so an injected `organizationId`/`cancelled_by` is dropped before the handler.
export const cancelFolioSchema = z.object({
  reason: z.string().trim().min(1).nullable().optional(),
})

export type CancelFolioInput = z.infer<typeof cancelFolioSchema>
