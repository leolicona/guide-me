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

export type AddExpenseInput = z.infer<typeof addExpenseSchema>
export type CreateDropInput = z.infer<typeof createDropSchema>
export type ReviewDropInput = z.infer<typeof reviewDropSchema>
export type CreatePayoutInput = z.infer<typeof createPayoutSchema>
