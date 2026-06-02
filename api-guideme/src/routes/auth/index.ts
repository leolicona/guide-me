import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { ApiError } from '../../types/errors'
import { login, logout, register, verify } from './handler'
import { loginSchema, registerSchema, verifyQuerySchema } from './schema'

const auth = new Hono<{ Bindings: CloudflareBindings }>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

auth.post('/register', zValidator('json', registerSchema, validationHook), register)
auth.get('/verify', zValidator('query', verifyQuerySchema, validationHook), verify)
auth.post('/login', zValidator('json', loginSchema, validationHook), login)
auth.post('/logout', logout)

export default auth
