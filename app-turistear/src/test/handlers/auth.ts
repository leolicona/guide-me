import { http, HttpResponse } from 'msw'

// passkey-auth D14, constitution IV — handlers mirror the endpoints the app calls: Better Auth's,
// through services/authClient.ts, and ours under /api/onboarding (services/authService.ts). Response
// SHAPES copy what the API's auth suites assert (test/auth/email-code, passkeys, passkey-management
// and test/onboarding/*); a fixture no API test would produce is a fiction.
//
// The BFF holds (constitution IV, v1.2.1): NO fixture carries a session token — the API strips it
// from every answer, and the session is an HttpOnly cookie the app never sees.
//
// Better Auth fails as `{ code, message }` at the top level; our routes keep `{ error: { … } }`.

const AT = '2026-10-03T16:30:00.000Z'

/** The `user` of a Better Auth sign-in answer (D4: Better Auth's model plus our input:false fields). */
export const aUser = (over: Record<string, unknown> = {}) => ({
  id: 'user-1',
  name: 'Luis Pérez',
  email: 'luis@ejemplo.mx',
  emailVerified: true,
  image: null,
  createdAt: AT,
  updatedAt: AT,
  organizationId: 'org-1',
  role: 'agent',
  status: 'active',
  phone: '+52 998 123 4567',
  plan: 'free',
  ...over,
})

/** `session` of a passkey sign-in — without `token`, which the API strips (D2, R14). */
export const aSession = (over: Record<string, unknown> = {}) => ({
  id: 'session-1',
  userId: 'user-1',
  expiresAt: '2026-10-10T16:30:00.000Z',
  createdAt: AT,
  updatedAt: AT,
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  ...over,
})

/** A Better Auth passkey record, as list-user-passkeys and verify-registration answer it. */
export const aPasskey = (over: Record<string, unknown> = {}) => ({
  id: 'passkey-1',
  name: 'iPhone',
  userId: 'user-1',
  credentialID: 'Y3JlZGVudGlhbC0x',
  publicKey: 'pQECAyYgASFYIGNvc2Uta2V5',
  counter: 0,
  deviceType: 'multiDevice',
  backedUp: true,
  transports: 'internal,hybrid',
  createdAt: AT,
  aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',
  ...over,
})

/** `GET /passkey/generate-authenticate-options` with no session: no `allowCredentials`. */
export const authenticateOptions = () => ({
  challenge: 'Y2hhbGxlbmdlLWF1dGg',
  rpId: 'app.turistearya.com',
  userVerification: 'preferred',
  timeout: 60000,
})

/** `GET /passkey/generate-register-options` on a fresh session (D8). */
export const registerOptions = () => ({
  challenge: 'Y2hhbGxlbmdlLXJlZ2lzdGVy',
  rp: { name: 'Turistear Ya!', id: 'app.turistearya.com' },
  user: { id: 'dXNlci0x', name: 'luis@ejemplo.mx', displayName: 'luis@ejemplo.mx' },
  pubKeyCredParams: [
    { alg: -8, type: 'public-key' },
    { alg: -7, type: 'public-key' },
    { alg: -257, type: 'public-key' },
  ],
  timeout: 60000,
  attestation: 'none',
  excludeCredentials: [],
  authenticatorSelection: {
    residentKey: 'required',
    userVerification: 'required',
    requireResidentKey: true,
  },
  extensions: { credProps: true },
})

export const anInvitation = (over: Record<string, unknown> = {}) => ({
  identity: 'luis@ejemplo.mx',
  identity_type: 'email',
  organization_name: 'Tours del Caribe',
  ...over,
})

/**
 * `GET /api/me` after a sign-in (unchanged by this feature: `{ user: UserPayload }`). Not a default
 * handler — a test that signs someone in says who.
 */
export const signedInAs = (role: 'admin' | 'agent') =>
  http.get('/api/me', () =>
    HttpResponse.json({
      user: {
        userId: 'user-1',
        name: 'Luis Pérez',
        email: 'luis@ejemplo.mx',
        role,
        organizationId: 'org-1',
      },
    }),
  )

/** A Better Auth refusal (`/api/auth/*`): `{ code, message }`, no envelope. */
export const betterAuthError = (status: number, code: string, message: string) =>
  HttpResponse.json({ code, message }, { status })

/** Better Auth's limiter (D9): a bare message, the wait in `X-Retry-After` seconds. */
export const rateLimited = (seconds: number) =>
  HttpResponse.json(
    { message: 'Too many requests. Please try again later.' },
    { status: 429, headers: { 'X-Retry-After': String(seconds) } },
  )

/** One of our routes refusing (`/api/onboarding/*`): the constitution IV envelope. */
export const onboardingError = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })

export const authHandlers = [
  // ─── Better Auth (services/authClient.ts) ──────────────────────────────────────────────────
  // FR-013 — the same answer for an address with no account.
  http.post('/api/auth/email-otp/send-verification-otp', () =>
    HttpResponse.json({ success: true }),
  ),
  http.post('/api/auth/sign-in/email-otp', () => HttpResponse.json({ user: aUser() })),
  http.post('/api/auth/sign-out', () => HttpResponse.json({ success: true })),
  http.get('/api/auth/passkey/generate-authenticate-options', () =>
    HttpResponse.json(authenticateOptions()),
  ),
  http.post('/api/auth/passkey/verify-authentication', () =>
    HttpResponse.json({ session: aSession(), user: aUser() }),
  ),
  http.get('/api/auth/passkey/generate-register-options', () =>
    HttpResponse.json(registerOptions()),
  ),
  http.post('/api/auth/passkey/verify-registration', () => HttpResponse.json(aPasskey())),
  http.get('/api/auth/passkey/list-user-passkeys', () => HttpResponse.json([aPasskey()])),
  http.post('/api/auth/passkey/update-passkey', async ({ request }) => {
    const { id, name } = (await request.json()) as { id: string; name: string }
    return HttpResponse.json({ passkey: aPasskey({ id, name }) })
  }),
  http.post('/api/auth/passkey/delete-passkey', () => HttpResponse.json({ status: true })),
  http.post('/api/auth/revoke-sessions', () => HttpResponse.json({ status: true })),

  // ─── Ours (services/authService.ts) ────────────────────────────────────────────────────────
  http.post('/api/onboarding/register', () =>
    HttpResponse.json({ message: 'Te enviamos un código a tu correo.' }, { status: 201 }),
  ),
  http.get('/api/onboarding/invitations/:token', () =>
    HttpResponse.json({ invitation: anInvitation() }),
  ),
  http.post('/api/onboarding/invitations/:token/accept', () =>
    HttpResponse.json({ email: 'luis@ejemplo.mx' }),
  ),
]
