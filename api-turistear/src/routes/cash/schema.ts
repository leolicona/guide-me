import { z } from 'zod'

// Agent continuous cash balance with cash drops. Only client-supplied fields appear here;
// organization_id / agent_id / status / balance_before / reviewed_by all come from context
// or server-side derivation (Rules 1 & 3). Zod strips unknown keys, so an injected
// `organizationId` / `agent_id` / `status` / `balance_before` is dropped before the handler.

export const addExpenseSchema = z.object({
  description: z.string().trim().min(1, 'Description is required'),
  amount: z.number().int().positive(),
})

export const createDropSchema = z.object({
  amount: z.number().int().positive(),
  note: z.string().trim().min(1).nullable().optional(),
})

export const reviewDropSchema = z.object({
  decision: z.enum(['confirmed', 'rejected']),
  note: z.string().trim().min(1).nullable().optional(),
  // Adjust-on-confirm: an admin MAY confirm with a corrected amount instead of forcing
  // reject-and-resubmit. Only honoured when `decision === 'confirmed'`; ignored on reject.
  amount: z.number().int().positive().optional(),
})

// US-A25 — admin registers a payout TO an agent. `agent_id` names the recipient (validated
// in-org server-side); organization_id / created_by come from context (Rules 1 & 3).
export const createPayoutSchema = z.object({
  agent_id: z.string().min(1),
  amount: z.number().int().positive(),
  note: z.string().trim().min(1).nullable().optional(),
})

// US-A27 — admin direct collection from an agent (face-to-face). `agent_id` names the agent
// (validated in-org server-side); organization_id / source / status / balance_* come from
// context or server derivation, never the body.
export const registerCollectionSchema = z.object({
  agent_id: z.string().min(1),
  amount: z.number().int().positive(),
  note: z.string().trim().min(1).nullable().optional(),
})

// US-AG27/AG28 — agent disputes a unilateral admin money-move. The reason is REQUIRED so the
// admin has context to resolve it.
export const disputeSchema = z.object({
  note: z.string().trim().min(1, 'A dispute reason is required'),
})

// US-A27/A28 — admin resolves an agent's dispute. The resolution note is REQUIRED (it closes
// the audit conversation) and is appended to `review_note`.
export const resolveDisputeSchema = z.object({
  note: z.string().trim().min(1, 'A resolution note is required'),
})

export type AddExpenseInput = z.infer<typeof addExpenseSchema>
export type CreateDropInput = z.infer<typeof createDropSchema>
export type ReviewDropInput = z.infer<typeof reviewDropSchema>
export type CreatePayoutInput = z.infer<typeof createPayoutSchema>
export type RegisterCollectionInput = z.infer<typeof registerCollectionSchema>
export type DisputeInput = z.infer<typeof disputeSchema>
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>
