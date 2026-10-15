import { z } from 'zod'

export const inviteAgentSchema = z.object({
  // passkey-auth R11 — lowercased at our edge, as Better Auth looks every email up lowercased.
  identity: z.string().trim().toLowerCase().email('Invalid email format'),
})

export type InviteAgentInput = z.infer<typeof inviteAgentSchema>

// No `organizationId` field — Multitenancy Rule 1 (taken from context, never the body).
// email / role / status are not editable here (status changes via deactivate/reactivate).
// No commission field either (rev. 2026-06-11): commission is service-based — defined on the
// catalog service, not the agent (docs/commissions/service-based-commission.spec.md). A
// client still sending `base_commission` is harmless (Zod strips unknown keys).
export const updateAgentSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().nullable().optional(),
})

export type UpdateAgentInput = z.infer<typeof updateAgentSchema>
