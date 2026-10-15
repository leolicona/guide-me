import { z } from 'zod'

// passkey-auth FR-060 — no form asks for a password. Emails are trimmed and lowercased at our edge
// (R11): Better Auth looks every address up lowercased.
const email = z.string().trim().toLowerCase().email('Correo electrónico inválido')

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es requerido'),
  email,
  company_name: z.string().trim().min(1, 'El nombre de la empresa es requerido'),
  phone: z.string().trim().min(1, 'El teléfono es requerido'),
})

export const inviteCompleteSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es requerido'),
})

/** The email step of the código por correo (passkey-auth US1). */
export const emailCodeRequestSchema = z.object({ email })

/** The code step: Better Auth's emailOTP issues 6 digits (D7). */
export const emailCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
})

/** A llave de acceso's name (FR-004). */
export const passkeyNameSchema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre').max(50, 'Máximo 50 caracteres'),
})

export type RegisterFormData = z.infer<typeof registerSchema>
export type InviteCompleteFormData = z.infer<typeof inviteCompleteSchema>
export type EmailCodeRequestFormData = z.infer<typeof emailCodeRequestSchema>
export type EmailCodeFormData = z.infer<typeof emailCodeSchema>
export type PasskeyNameFormData = z.infer<typeof passkeyNameSchema>
