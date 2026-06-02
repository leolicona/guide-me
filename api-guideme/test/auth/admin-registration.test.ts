import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'

const VALID_BODY = {
  name: 'Leo Licona',
  email: 'leo@empresa.com',
  password: 'S3cur3Pass!',
  company_name: 'Empresa S.A.',
  phone: '+52 55 1234 5678',
}

const buildFakeJwt = (identity: string): string => {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  const payload = btoa(JSON.stringify({ sub: identity, exp: Date.now() / 1000 + 900 }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `${header}.${payload}.signature`
}

const mockAgnosticAuth = (
  routes: Partial<Record<'/auth/hash' | '/auth/initiate' | '/auth/verify', () => Response>>,
) => {
  vi.spyOn(env.AGNOSTIC_AUTH_API, 'fetch').mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const pathname = new URL(url).pathname as keyof typeof routes
      const handler = routes[pathname]
      if (handler) return handler()
      return new Response('{"success":false}', { status: 404 })
    },
  )
}

const mockResend = () => {
  const calls: Array<{ to: unknown; from: unknown; subject: unknown; html: unknown }> = []
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://api.resend.com/emails')) {
      const body = JSON.parse(init?.body as string)
      calls.push(body)
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
    }
    return original(input, init)
  })
  return calls
}

const clearDb = async () => {
  await env.DB.exec('DELETE FROM users')
  await env.DB.exec('DELETE FROM organizations')
}

beforeEach(async () => {
  await clearDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Admin Registration — POST /api/auth/register', () => {
  it('Scenario 1: registers a new admin successfully', async () => {
    mockAgnosticAuth({
      '/auth/hash': () =>
        new Response(
          JSON.stringify({ success: true, data: { hash: 'HASHED_VALUE', salt: 'SALT_VALUE' } }),
          { status: 200 },
        ),
      '/auth/initiate': () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { token: 'tok_abc123', magicLink: 'https://example.com/verify?token=tok_abc123' },
          }),
          { status: 200 },
        ),
    })
    const resendCalls = mockResend()

    const res = await SELF.fetch('http://api.local/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { message: string }
    expect(body.message).toBe('Registro exitoso. Revisa tu correo para verificar tu cuenta.')

    const orgRow = await env.DB.prepare('SELECT name FROM organizations').first<{ name: string }>()
    expect(orgRow?.name).toBe('Empresa S.A.')

    const userRow = await env.DB.prepare(
      'SELECT email, role, status, plan, password_hash FROM users WHERE email = ?',
    )
      .bind(VALID_BODY.email)
      .first<{ email: string; role: string; status: string; plan: string; password_hash: string }>()

    expect(userRow).toBeTruthy()
    expect(userRow!.email).toBe('leo@empresa.com')
    expect(userRow!.role).toBe('admin')
    expect(userRow!.status).toBe('unverified')
    expect(userRow!.plan).toBe('free')
    expect(userRow!.password_hash).not.toBe(VALID_BODY.password)
    expect(userRow!.password_hash).toBe('HASHED_VALUE')

    expect(resendCalls.length).toBe(1)
    expect(resendCalls[0].to).toBe('leo@empresa.com')

    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('Scenario 2: returns 409 when email already exists', async () => {
    mockAgnosticAuth({
      '/auth/hash': () =>
        new Response(
          JSON.stringify({ success: true, data: { hash: 'h', salt: 's' } }),
          { status: 200 },
        ),
      '/auth/initiate': () =>
        new Response(
          JSON.stringify({ success: true, data: { token: 't', magicLink: 'l' } }),
          { status: 200 },
        ),
    })
    mockResend()

    // Insert first registration
    await SELF.fetch('http://api.local/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })

    const countBefore = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first<{ c: number }>()

    // Attempt second registration with same email
    const res = await SELF.fetch('http://api.local/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('EMAIL_ALREADY_EXISTS')

    const countAfter = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first<{ c: number }>()
    expect(countAfter?.c).toBe(countBefore?.c)
  })

  it('Scenario 3: returns 400 when required fields are missing', async () => {
    const res = await SELF.fetch('http://api.local/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo@empresa.com' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')

    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('Scenario 4: returns 400 when email has invalid format', async () => {
    const res = await SELF.fetch('http://api.local/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, email: 'no-es-un-email' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('Admin Verification — GET /api/auth/verify', () => {
  const seedUnverifiedUser = async (email = VALID_BODY.email) => {
    mockAgnosticAuth({
      '/auth/hash': () =>
        new Response(
          JSON.stringify({ success: true, data: { hash: 'HASHED', salt: 'SALT' } }),
          { status: 200 },
        ),
      '/auth/initiate': () =>
        new Response(
          JSON.stringify({ success: true, data: { token: 'tok', magicLink: 'l' } }),
          { status: 200 },
        ),
    })
    mockResend()

    await SELF.fetch('http://api.local/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, email }),
    })

    vi.restoreAllMocks()
  }

  it('Scenario 5: verifies a valid token, activates the user and sets session cookies', async () => {
    await seedUnverifiedUser()

    const fakeJwt = buildFakeJwt(VALID_BODY.email)
    mockAgnosticAuth({
      '/auth/verify': () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { jwt: fakeJwt, refreshToken: 'refresh_xyz' },
          }),
          { status: 200 },
        ),
    })

    const res = await SELF.fetch('http://api.local/api/auth/verify?token=tok_valid')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { name: string; role: string } }
    expect(body.user.name).toBe('Leo Licona')
    expect(body.user.role).toBe('admin')
    expect(JSON.stringify(body)).not.toContain(fakeJwt)
    expect(JSON.stringify(body)).not.toContain('refresh_xyz')

    const setCookies = res.headers.getSetCookie?.() ?? []
    const cookieHeader = setCookies.join('\n')
    expect(cookieHeader).toMatch(/gm_access=/)
    expect(cookieHeader).toMatch(/gm_refresh=/)
    expect(cookieHeader).toMatch(/HttpOnly/i)
    expect(cookieHeader).toMatch(/Secure/i)
    expect(cookieHeader).toMatch(/SameSite=Lax/i)
    expect(cookieHeader).toMatch(/Path=\/api\/auth\/refresh/i)

    const user = await env.DB.prepare('SELECT status FROM users WHERE email = ?')
      .bind(VALID_BODY.email)
      .first<{ status: string }>()
    expect(user?.status).toBe('active')
  })

  it('Scenario 6: returns 400 INVALID_TOKEN when token is invalid or expired', async () => {
    await seedUnverifiedUser()

    mockAgnosticAuth({
      '/auth/verify': () =>
        new Response(
          JSON.stringify({ success: false, error: { code: 'INVALID_TOKEN' } }),
          { status: 400 },
        ),
    })

    const res = await SELF.fetch('http://api.local/api/auth/verify?token=invalid_token')

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_TOKEN')

    const setCookies = res.headers.getSetCookie?.() ?? []
    expect(setCookies.length).toBe(0)

    const user = await env.DB.prepare('SELECT status FROM users WHERE email = ?')
      .bind(VALID_BODY.email)
      .first<{ status: string }>()
    expect(user?.status).toBe('unverified')
  })

  it('Scenario 7: returns 400 INVALID_TOKEN when token has already been consumed', async () => {
    await seedUnverifiedUser()

    const fakeJwt = buildFakeJwt(VALID_BODY.email)
    let callCount = 0
    vi.spyOn(env.AGNOSTIC_AUTH_API, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      const pathname = new URL(url).pathname
      if (pathname === '/auth/verify') {
        callCount++
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              success: true,
              data: { jwt: fakeJwt, refreshToken: 'refresh_xyz' },
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({ success: false, error: { code: 'INVALID_TOKEN' } }),
          { status: 400 },
        )
      }
      return new Response('{"success":false}', { status: 404 })
    })

    // First call — success
    const first = await SELF.fetch('http://api.local/api/auth/verify?token=tok_once')
    expect(first.status).toBe(200)

    // Second call with same token — should be rejected
    const second = await SELF.fetch('http://api.local/api/auth/verify?token=tok_once')
    expect(second.status).toBe(400)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_TOKEN')
  })
})
