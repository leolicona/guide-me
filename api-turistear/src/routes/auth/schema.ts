import { z } from 'zod'

export const registerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  company_name: z.string().min(1, 'Company name is required'),
  phone: z.string().min(1, 'Phone is required'),
})

export type RegisterInput = z.infer<typeof registerSchema>

export const verifyQuerySchema = z.object({
  token: z.string().min(1, 'Token is required'),
})

export type VerifyQuery = z.infer<typeof verifyQuerySchema>

// BUG-010 — verification consumes a single-use token, so the app calls it as a POST
// (a GET gets refetched by tab focus and prefetched by mail-link scanners, burning the
// token). Same shape as the query variant; the GET route stays for legacy deep-links.
export const verifyBodySchema = verifyQuerySchema

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
})

export type LoginInput = z.infer<typeof loginSchema>

export const acceptInviteQuerySchema = z.object({
  token: z.string().min(1, 'Token is required'),
})

export type AcceptInviteQuery = z.infer<typeof acceptInviteQuerySchema>

export const completeInviteSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  name: z.string().min(1, 'Name is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  // US-AF01 — optional job title, only meaningful for an affiliate invite (the company is
  // created by the admin, so it is shown read-only, never entered here). Ignored for an agent.
  position: z.string().optional(),
})

export type CompleteInviteInput = z.infer<typeof completeInviteSchema>

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email format'),
})

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
