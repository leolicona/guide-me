import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { ApiError } from '../../types/errors'
import {
  acceptInvite,
  completeInvite,
  forgotPassword,
  login,
  logout,
  register,
  resetPassword,
  verify,
} from './handler'
import {
  acceptInviteQuerySchema,
  completeInviteSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyBodySchema,
  verifyQuerySchema,
} from './schema'

const auth = new Hono<{ Bindings: CloudflareBindings }>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

auth.post('/register', zValidator('json', registerSchema, validationHook), register)
auth.get('/verify', zValidator('query', verifyQuerySchema, validationHook), verify)
// BUG-010 — the app submits verification as POST so refetches/prefetches of the GET
// can never burn the single-use token. The GET above remains for legacy deep-links.
auth.post('/verify', zValidator('json', verifyBodySchema, validationHook), verify)
auth.post('/login', zValidator('json', loginSchema, validationHook), login)
auth.post('/logout', logout)
auth.get(
  '/invite/accept',
  zValidator('query', acceptInviteQuerySchema, validationHook),
  acceptInvite,
)
auth.post(
  '/invite/complete',
  zValidator('json', completeInviteSchema, validationHook),
  completeInvite,
)
auth.post(
  '/forgot-password',
  zValidator('json', forgotPasswordSchema, validationHook),
  forgotPassword,
)
auth.post(
  '/reset-password',
  zValidator('json', resetPasswordSchema, validationHook),
  resetPassword,
)

export default auth
