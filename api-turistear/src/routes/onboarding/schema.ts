import { z } from 'zod'

// passkey-auth R11 — every email is lowercased at our edge, as Better Auth lowercases before every
// lookup.
const email = z.string().trim().toLowerCase().email('Invalid email format')

// passkey-auth D10, FR-030 — no password: the email code verifies the address and signs in.
export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email,
  company_name: z.string().trim().min(1, 'Company name is required'),
  phone: z.string().trim().min(1, 'Phone is required'),
})

export type RegisterInput = z.infer<typeof registerSchema>

export const invitationTokenSchema = z.object({
  token: z.string().min(1, 'Token is required'),
})

// passkey-auth D11, FR-031 — a name, then the email code.
export const acceptInvitationSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
})

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>
