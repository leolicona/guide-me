import { z } from 'zod'

export const inviteAgentSchema = z.object({
  identity: z.string().email('Correo electrónico inválido'),
})

export type InviteAgentFormData = z.infer<typeof inviteAgentSchema>

// US-A07 — edit agent profile (name, phone). No commission here (rev. 2026-06-11): commission
// is defined per service in the catalog (docs/commissions/service-based-commission.spec.md).
export const editAgentSchema = z.object({
  name: z.string().min(1, 'El nombre es obligatorio'),
  phone: z.string().optional(),
})

export type EditAgentFormData = z.infer<typeof editAgentSchema>
