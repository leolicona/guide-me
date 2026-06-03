import { z } from 'zod'

export const inviteAgentSchema = z.object({
  identity: z.string().email('Correo electrónico inválido'),
})

export type InviteAgentFormData = z.infer<typeof inviteAgentSchema>

// US-A07 — edit agent. `commission` is a percent (0–100) the admin types; the
// form converts it to basis points (percentToBasisPoints) before calling the API.
export const editAgentSchema = z.object({
  name: z.string().min(1, 'El nombre es obligatorio'),
  phone: z.string().optional(),
  commission: z
    .number()
    .min(0, 'La comisión mínima es 0%')
    .max(100, 'La comisión máxima es 100%')
    .refine((v) => Number(v.toFixed(2)) === v, 'Máximo 2 decimales'),
})

export type EditAgentFormData = z.infer<typeof editAgentSchema>
