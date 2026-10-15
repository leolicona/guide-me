import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { ApiError } from '../../types/errors'
import { acceptInvitation, getInvitation, register } from './handler'
import { acceptInvitationSchema, invitationTokenSchema, registerSchema } from './schema'

// passkey-auth D2 — what Better Auth cannot know (organizations, invitations) lives here, under our
// own rules (constitution IV). Signing in is Better Auth's: each flow ends by sending a sign-in
// code, which the app redeems with `authClient.signIn.emailOtp`.
const onboarding = new Hono<{ Bindings: CloudflareBindings }>()

const validationHook = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 400, 'Invalid request payload')
  }
}

onboarding.post('/register', zValidator('json', registerSchema, validationHook), register)
onboarding.get(
  '/invitations/:token',
  zValidator('param', invitationTokenSchema, validationHook),
  getInvitation,
)
onboarding.post(
  '/invitations/:token/accept',
  zValidator('param', invitationTokenSchema, validationHook),
  zValidator('json', acceptInvitationSchema, validationHook),
  acceptInvitation,
)

export default onboarding
