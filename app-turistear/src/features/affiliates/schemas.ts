import { z } from 'zod'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Company profile as edited in the CompanyInfoSheet. Contact fields are optional — empty
// strings map to null at save; a non-empty email must be valid.
export const affiliateCompanySchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio'),
  contact_email: z
    .string()
    .trim()
    .refine((v) => v === '' || EMAIL_RE.test(v), 'Correo inválido'),
  contact_phone: z.string().trim(),
})

export type AffiliateCompanyFormData = z.infer<typeof affiliateCompanySchema>
