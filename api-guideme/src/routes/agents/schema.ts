import { z } from 'zod'

export const inviteAgentSchema = z.object({
  identity: z.string().email('Invalid email format'),
})

export type InviteAgentInput = z.infer<typeof inviteAgentSchema>
