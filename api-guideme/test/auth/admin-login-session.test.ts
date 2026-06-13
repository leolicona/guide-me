import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { buildFakeJwt } from '../helpers/jwt'

const USER_EMAIL = 'usuario@empresa.com'
const USER_NAME = 'Usuario Prueba'
const USER_PASSWORD = 'S3cur3Pass!'
const ORG_NAME = 'Empresa S.A.'

const clearDb = async () => {
  await env.DB.exec('DELETE FROM users')
  await env.DB.exec('DELETE FROM organizations')
}

interface SeedOptions {
  email?: string
  name?: string
  status?: 'unverified' | 'active' | 'suspended'
  role?: 'admin' | 'agent'
}

const seedUser = async ({
  email = USER_EMAIL,
  name = USER_NAME,
  status = 'active',
  role = 'admin',
}: SeedOptions = {}): Promise<{ userId: string; organizationId: string }> => {
  const organizationId = crypto.randomUUID()
  const userId = crypto.randomUUID()

  await env.DB.prepare(
    'INSERT INTO organizations (id, name) VALUES (?, ?)',
  )
    .bind(organizationId, ORG_NAME)
    .run()

  await env.DB.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, phone, role, status, plan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      organizationId,
      name,
      email,
      'STORED_HASH',
      'STORED_SALT',
      '+52 55 1234 5678',
      role,
      status,
      'free',
    )
    .run()

  return { userId, organizationId }
}

const mockAgnosticAuth = (
  routes: Partial<
    Record<
      | '/auth/hash'
      | '/auth/initiate'
      | '/auth/verify'
      | '/auth/verify-password'
      | '/auth/refresh'
      | '/auth/token/revoke',
      (body: unknown) => Response
    >
  >,
) => {
  const calls: Array<{ pathname: string; body: unknown }> = []
  vi.spyOn(env.AGNOSTIC_AUTH_API, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const pathname = new URL(url).pathname as keyof typeof routes
      const parsedBody = init?.body ? JSON.parse(init.body as string) : undefined
      calls.push({ pathname, body: parsedBody })
      const handler = routes[pathname]
      if (handler) return handler(parsedBody)
      return new Response('{"success":false}', { status: 404 })
    },
  )
  return calls
}

beforeEach(async () => {
  await clearDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Admin Login — POST /api/auth/login', () => {
  it('Scenario 1: logs in successfully and sets session cookies', async () => {
    await seedUser()

    const jwt = buildFakeJwt(USER_EMAIL)
    const refreshToken = 'refresh_xyz'

    mockAgnosticAuth({
      '/auth/verify-password': () =>
        new Response(
          JSON.stringify({ success: true, data: { jwt, refreshToken } }),
          { status: 200 },
        ),
    })

    const res = await SELF.fetch('http://api.local/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { name: string; role: string } }
    expect(body.user.name).toBe(USER_NAME)
    expect(body.user.role).toBe('admin')

    const bodyStr = JSON.stringify(body)
    expect(bodyStr).not.toContain(jwt)
    expect(bodyStr).not.toContain(refreshToken)

    const setCookies = res.headers.getSetCookie?.() ?? []
    const cookieHeader = setCookies.join('\n')
    expect(cookieHeader).toMatch(/gm_access=/)
    expect(cookieHeader).toMatch(/gm_refresh=/)
    expect(cookieHeader).toMatch(/HttpOnly/i)
    expect(cookieHeader).toMatch(/Secure/i)
    expect(cookieHeader).toMatch(/SameSite=Lax/i)
    expect(cookieHeader).toMatch(/Max-Age=900/)
    expect(cookieHeader).toMatch(/Max-Age=604800/)
  })

  it('Scenario 2: returns 401 INVALID_CREDENTIALS when password is incorrect', async () => {
    await seedUser()

    mockAgnosticAuth({
      '/auth/verify-password': () =>
        new Response(
          JSON.stringify({ success: false, error: { code: 'INVALID_CREDENTIALS' } }),
          { status: 401 },
        ),
    })

    const res = await SELF.fetch('http://api.local/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL, password: 'WrongPass!' }),
    })

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_CREDENTIALS')
    // Spec: message must not pin-point which field was wrong.
    // The phrasing "invalid email or password" is acceptable — it explicitly
    // names both so it cannot be used to discriminate between them.
    expect(body.error.message).not.toMatch(/incorrect password/i)
    expect(body.error.message).not.toMatch(/wrong password/i)
    expect(body.error.message).not.toMatch(/email (?:not|does not) (?:exist|found)/i)

    const setCookies = res.headers.getSetCookie?.() ?? []
    expect(setCookies.length).toBe(0)
  })

  it('Scenario 3: returns 401 INVALID_CREDENTIALS when email is not registered (same error as bad password)', async () => {
    const verifyPasswordSpy = vi.fn()
    mockAgnosticAuth({
      '/auth/verify-password': () => {
        verifyPasswordSpy()
        return new Response(
          JSON.stringify({ success: true, data: { jwt: 'j', refreshToken: 'r' } }),
          { status: 200 },
        )
      },
    })

    const res = await SELF.fetch('http://api.local/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noexiste@empresa.com', password: USER_PASSWORD }),
    })

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_CREDENTIALS')
    expect(verifyPasswordSpy).not.toHaveBeenCalled()
  })

  it('Scenario 4: returns 403 EMAIL_NOT_VERIFIED when status is unverified', async () => {
    await seedUser({ status: 'unverified' })

    const verifyPasswordSpy = vi.fn()
    mockAgnosticAuth({
      '/auth/verify-password': () => {
        verifyPasswordSpy()
        return new Response(
          JSON.stringify({ success: true, data: { jwt: 'j', refreshToken: 'r' } }),
          { status: 200 },
        )
      },
    })

    const res = await SELF.fetch('http://api.local/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('EMAIL_NOT_VERIFIED')
    expect(verifyPasswordSpy).not.toHaveBeenCalled()

    const setCookies = res.headers.getSetCookie?.() ?? []
    expect(setCookies.length).toBe(0)
  })

  it('Scenario 5: returns 400 VALIDATION_ERROR when fields are missing', async () => {
    const res = await SELF.fetch('http://api.local/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('Auth Middleware — protected routes', () => {
  it('Scenario 6: allows access with valid JWT and attaches user to context', async () => {
    const seeded = await seedUser()
    const jwt = buildFakeJwt(USER_EMAIL)

    const res = await SELF.fetch('http://api.local/api/me', {
      headers: { Cookie: `gm_access=${jwt}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user: { userId: string; email: string; role: string; organizationId: string }
    }
    expect(body.user.email).toBe(USER_EMAIL)
    expect(body.user.role).toBe('admin')
    expect(body.user.userId).toBe(seeded.userId)
    expect(body.user.organizationId).toBe(seeded.organizationId)

    const setCookies = res.headers.getSetCookie?.() ?? []
    expect(setCookies.length).toBe(0)
  })

  it('Scenario 7: transparently renews session when JWT is expired and refresh is valid', async () => {
    await seedUser()
    const expiredJwt = buildFakeJwt(USER_EMAIL, -60)
    const newJwt = buildFakeJwt(USER_EMAIL)
    const newRefreshToken = 'refresh_new'

    mockAgnosticAuth({
      '/auth/refresh': () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { jwt: newJwt, refreshToken: newRefreshToken },
          }),
          { status: 200 },
        ),
    })

    const res = await SELF.fetch('http://api.local/api/me', {
      headers: { Cookie: `gm_access=${expiredJwt}; gm_refresh=old_refresh` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { email: string } }
    expect(body.user.email).toBe(USER_EMAIL)

    const setCookies = res.headers.getSetCookie?.() ?? []
    const cookieHeader = setCookies.join('\n')
    expect(cookieHeader).toMatch(/gm_access=/)
    expect(cookieHeader).toMatch(/gm_refresh=/)
    expect(cookieHeader).toMatch(/Max-Age=900/)
    expect(cookieHeader).toMatch(/Max-Age=604800/)
  })

  it('Scenario 8: returns 401 UNAUTHORIZED — and does NOT clear cookies — when refresh fails (BUG-014)', async () => {
    await seedUser()
    const expiredJwt = buildFakeJwt(USER_EMAIL, -60)

    mockAgnosticAuth({
      '/auth/refresh': () =>
        new Response(
          JSON.stringify({ success: false, error: { code: 'INVALID_TOKEN' } }),
          { status: 401 },
        ),
    })

    const res = await SELF.fetch('http://api.local/api/me', {
      headers: { Cookie: `gm_access=${expiredJwt}; gm_refresh=bad_refresh` },
    })

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')

    // BUG-014 — a failed refresh must NOT emit delete-cookie headers: parallel requests
    // race the rotation, and a loser's clear arriving after the winner's Set-Cookie would
    // wipe the brand-new valid session. A dead refresh token grants nothing anyway.
    const setCookies = res.headers.getSetCookie?.() ?? []
    expect(setCookies).toEqual([])
  })

  it('Scenario 9: returns 401 UNAUTHORIZED without attempting refresh when no access cookie', async () => {
    await seedUser()
    const refreshSpy = vi.fn()
    mockAgnosticAuth({
      '/auth/refresh': () => {
        refreshSpy()
        return new Response(
          JSON.stringify({ success: true, data: { jwt: 'j', refreshToken: 'r' } }),
          { status: 200 },
        )
      },
    })

    const res = await SELF.fetch('http://api.local/api/me')

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('Scenario 10: returns 403 FORBIDDEN when user role does not satisfy requirement', async () => {
    await seedUser({ role: 'agent' })
    const jwt = buildFakeJwt(USER_EMAIL)

    const res = await SELF.fetch('http://api.local/api/admin-only', {
      method: 'POST',
      headers: { Cookie: `gm_access=${jwt}` },
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })
})

describe('Logout — POST /api/auth/logout', () => {
  it('Scenario 11: revokes refresh token and clears cookies', async () => {
    const calls = mockAgnosticAuth({
      '/auth/token/revoke': () =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
    })

    const res = await SELF.fetch('http://api.local/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: 'gm_access=some_jwt; gm_refresh=refresh_token_value' },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { message: string }
    expect(body.message).toBe('Sesión cerrada correctamente.')

    const revokeCall = calls.find((c) => c.pathname === '/auth/token/revoke')
    expect(revokeCall).toBeTruthy()
    expect((revokeCall!.body as { refreshToken: string }).refreshToken).toBe(
      'refresh_token_value',
    )

    const setCookies = res.headers.getSetCookie?.() ?? []
    const cookieHeader = setCookies.join('\n')
    expect(cookieHeader).toMatch(/gm_access=/)
    expect(cookieHeader).toMatch(/gm_refresh=/)
    expect(cookieHeader).toMatch(/Max-Age=0/)
  })

  it('Scenario 12: returns 200 idempotently when no session cookie is present', async () => {
    const revokeSpy = vi.fn()
    mockAgnosticAuth({
      '/auth/token/revoke': () => {
        revokeSpy()
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      },
    })

    const res = await SELF.fetch('http://api.local/api/auth/logout', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    expect(revokeSpy).not.toHaveBeenCalled()

    const setCookies = res.headers.getSetCookie?.() ?? []
    const cookieHeader = setCookies.join('\n')
    expect(cookieHeader).toMatch(/gm_access=/)
    expect(cookieHeader).toMatch(/gm_refresh=/)
    expect(cookieHeader).toMatch(/Max-Age=0/)
  })
})
