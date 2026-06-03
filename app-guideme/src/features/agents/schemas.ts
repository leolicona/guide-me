import { z } from 'zod'

export const inviteAgentSchema = z.object({
  identity: z.string().email('Correo electrónico inválido'),
})

export type InviteAgentFormData = z.infer<typeof inviteAgentSchema>
