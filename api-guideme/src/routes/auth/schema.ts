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
})

export type CompleteInviteInput = z.infer<typeof completeInviteSchema>
