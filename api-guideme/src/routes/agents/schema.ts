import { z } from 'zod'

export const inviteAgentSchema = z.object({
  identity: z.string().email('Invalid email format'),
})

export type InviteAgentInput = z.infer<typeof inviteAgentSchema>

// base_commission is in basis points (0–10000; 1050 = 10.50%).
// No `organizationId` field — Multitenancy Rule 1 (taken from context, never the body).
// email / role / status are not editable here (status changes via deactivate/reactivate).
export const updateAgentSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().nullable().optional(),
  base_commission: z.number().int().min(0).max(10000),
})

export type UpdateAgentInput = z.infer<typeof updateAgentSchema>
