import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'

const USER_EMAIL = 'leo@empresa.com'
const USER_NAME = 'Leo Test'
const ORG_NAME = 'Empresa S.A.'
const NEW_PASSWORD = 'NuevaS3cur3Pass!'

const clearDb = async () => {
  await env.DB.exec('DELETE FROM password_reset_tokens')
  await env.DB.exec('DELETE FROM invitations')
  await env.DB.exec('DELETE FROM users')
  await env.DB.exec('DELETE FROM organizations')
}

interface SeedUserOptions {
  email?: string
  name?: string
  status?: 'unverified' | 'active' | 'suspended'
  role?: 'admin' | 'agent'
  passwordHash?: string
  passwordSalt?: string
  organizationId?: string
}

const seedUser = async ({
  email = USER_EMAIL,
  name = USER_NAME,
  status = 'active',
  role = 'admin',
  passwordHash = 'OLD_HASH',
  passwordSalt = 'OLD_SALT',
  organizationId,
}: SeedUserOptions = {}): Promise<{ userId: string; organizationId: string }> => {
  const orgId = organizationId ?? crypto.randomUUID()
  const userId = crypto.randomUUID()

  if (!organizationId) {
    await env.DB.prepare(
      'INSERT INTO organizations (id, name) VALUES (?, ?)',
    )
      .bind(orgId, ORG_NAME)
      .run()
  }

  await env.DB.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, password_salt, phone, role, status, plan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      orgId,
      name,
      email,
      passwordHash,
      passwordSalt,
      '+52 55 1234 5678',
      role,
      status,
      'free',
    )
    .run()

  return { userId, organizationId: orgId }
}

interface SeedResetTokenOptions {
  userId: string
  token?: string
  expiresInSeconds?: number
}

const seedResetToken = async ({
  userId,
  token = 'reset_token_abc',
  expiresInSeconds = 60 * 60,
}: SeedResetTokenOptions): Promise<{ id: string; token: string }> => {
  const id = crypto.randomUUID()
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds
  await env.DB.prepare(
    `INSERT INTO password_reset_tokens (id, user_id, token, expires_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(id, userId, token, expiresAt)
    .run()
  return { id, token }
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

const mockResend = () => {
  const calls: Array<{ to: unknown; from: unknown; subject: unknown; html: unknown }> = []
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    if (url.startsWith('https://api.resend.com/emails')) {
      const body = JSON.parse(init?.body as string)
      calls.push(body)
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
    }
    return original(input, init)
  })
  return calls
}

beforeEach(async () => {
  await clearDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Forgot Password — POST /api/auth/forgot-password', () => {
  it('Scenario 1: registered email — creates token, sends email, returns generic response', async () => {
    const user = await seedUser()
    const resendCalls = mockResend()

    const res = await SELF.fetch('http://api.local/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { message: string }
    expect(body.message).toBe(
      'Si el correo está registrado, recibirás instrucciones.',
    )

    const tokenRow = await env.DB.prepare(
      'SELECT id, user_id, token, expires_at FROM password_reset_tokens WHERE user_id = ?',
    )
      .bind(user.userId)
      .first<{
        id: string
        user_id: string
        token: string
        expires_at: number
      }>()

    expect(tokenRow).toBeTruthy()
    expect(tokenRow!.user_id).toBe(user.userId)
    expect(tokenRow!.token).toBeTruthy()

    const nowSeconds = Math.floor(Date.now() / 1000)
    const oneHourSeconds = 60 * 60
    expect(tokenRow!.expires_at).toBeGreaterThan(nowSeconds + oneHourSeconds - 60)
    expect(tokenRow!.expires_at).toBeLessThan(nowSeconds + oneHourSeconds + 60)

    expect(resendCalls.length).toBe(1)
    expect(resendCalls[0].to).toBe(USER_EMAIL)
    expect((resendCalls[0].html as string)).toContain(
      `/reset-password?token=${tokenRow!.token}`,
    )

    const setCookies = res.headers.getSetCookie?.() ?? []
    expect(setCookies.length).toBe(0)
  })

  it('Scenario 2: unregistered email — returns same generic response, no token, no email', async () => {
    const resendCalls = mockResend()

    const res = await SELF.fetch('http://api.local/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noexiste@empresa.com' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { message: string }
    expect(body.message).toBe(
      'Si el correo está registrado, recibirás instrucciones.',
    )

    const count = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM password_reset_tokens',
    ).first<{ c: number }>()
    expect(count?.c).toBe(0)

    expect(resendCalls.length).toBe(0)
  })

  it('Scenario 3: re-request invalidates the previous active token', async () => {
    const user = await seedUser()
    const previous = await seedResetToken({
      userId: user.userId,
      token: 'old_token',
    })
    mockResend()

    const res = await SELF.fetch('http://api.local/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL }),
    })

    expect(res.status).toBe(200)

    const previousRow = await env.DB.prepare(
      'SELECT id FROM password_reset_tokens WHERE id = ?',
    )
      .bind(previous.id)
      .first<{ id: string }>()
    expect(previousRow).toBeNull()

    const activeRows = await env.DB.prepare(
      'SELECT token FROM password_reset_tokens WHERE user_id = ?',
    )
      .bind(user.userId)
      .all<{ token: string }>()
    expect(activeRows.results.length).toBe(1)
    expect(activeRows.results[0].token).not.toBe('old_token')
  })
})

describe('Reset Password — POST /api/auth/reset-password', () => {
  it('Scenario 4: valid token — updates hash, deletes token, no cookies set', async () => {
    const user = await seedUser()
    await seedResetToken({ userId: user.userId, token: 'valid_reset_token' })

    mockAgnosticAuth({
      '/auth/hash': () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { hash: 'NEW_HASHED_VALUE', salt: 'NEW_SALT_VALUE' },
          }),
          { status: 200 },
        ),
    })

    const res = await SELF.fetch('http://api.local/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'valid_reset_token',
        password: NEW_PASSWORD,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { message: string }
    expect(body.message).toBe('Contraseña actualizada correctamente.')

    const userRow = await env.DB.prepare(
      'SELECT password_hash, password_salt FROM users WHERE id = ?',
    )
      .bind(user.userId)
      .first<{ password_hash: string; password_salt: string }>()
    expect(userRow!.password_hash).toBe('NEW_HASHED_VALUE')
    expect(userRow!.password_salt).toBe('NEW_SALT_VALUE')
    expect(userRow!.password_hash).not.toBe(NEW_PASSWORD)

    const tokenCount = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM password_reset_tokens',
    ).first<{ c: number }>()
    expect(tokenCount?.c).toBe(0)

    const setCookies = res.headers.getSetCookie?.() ?? []
    expect(setCookies.length).toBe(0)
  })

  it('Scenario 5: inexistent token — returns 400 INVALID_TOKEN, hash unchanged', async () => {
    const user = await seedUser()

    const hashSpy = vi.fn()
    mockAgnosticAuth({
      '/auth/hash': () => {
        hashSpy()
        return new Response(
          JSON.stringify({ success: true, data: { hash: 'h', salt: 's' } }),
          { status: 200 },
        )
      },
    })

    const res = await SELF.fetch('http://api.local/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'does_not_exist',
        password: NEW_PASSWORD,
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_TOKEN')
    expect(hashSpy).not.toHaveBeenCalled()

    const userRow = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    )
      .bind(user.userId)
      .first<{ password_hash: string }>()
    expect(userRow!.password_hash).toBe('OLD_HASH')
  })

  it('Scenario 6: expired token — returns 400 INVALID_TOKEN, hash unchanged', async () => {
    const user = await seedUser()
    await seedResetToken({
      userId: user.userId,
      token: 'expired_token',
      expiresInSeconds: -60,
    })

    const hashSpy = vi.fn()
    mockAgnosticAuth({
      '/auth/hash': () => {
        hashSpy()
        return new Response(
          JSON.stringify({ success: true, data: { hash: 'h', salt: 's' } }),
          { status: 200 },
        )
      },
    })

    const res = await SELF.fetch('http://api.local/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'expired_token',
        password: NEW_PASSWORD,
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_TOKEN')
    expect(hashSpy).not.toHaveBeenCalled()

    const userRow = await env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?',
    )
      .bind(user.userId)
      .first<{ password_hash: string }>()
    expect(userRow!.password_hash).toBe('OLD_HASH')
  })

  it('Scenario 7: already consumed token — returns 400 INVALID_TOKEN', async () => {
    const user = await seedUser()

    mockAgnosticAuth({
      '/auth/hash': () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { hash: 'NEW_HASH', salt: 'NEW_SALT' },
          }),
          { status: 200 },
        ),
    })

    await seedResetToken({ userId: user.userId, token: 'single_use_token' })
    const firstRes = await SELF.fetch(
      'http://api.local/api/auth/reset-password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'single_use_token',
          password: NEW_PASSWORD,
        }),
      },
    )
    expect(firstRes.status).toBe(200)

    const secondRes = await SELF.fetch(
      'http://api.local/api/auth/reset-password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'single_use_token',
          password: NEW_PASSWORD,
        }),
      },
    )
    expect(secondRes.status).toBe(400)
    const body = (await secondRes.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_TOKEN')
  })

  it('Scenario 8: returns 400 VALIDATION_ERROR when token or password is missing', async () => {
    const missingToken = await SELF.fetch(
      'http://api.local/api/auth/reset-password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: NEW_PASSWORD }),
      },
    )
    expect(missingToken.status).toBe(400)
    const missingTokenBody = (await missingToken.json()) as {
      error: { code: string }
    }
    expect(missingTokenBody.error.code).toBe('VALIDATION_ERROR')

    const missingPassword = await SELF.fetch(
      'http://api.local/api/auth/reset-password',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'whatever' }),
      },
    )
    expect(missingPassword.status).toBe(400)
    const missingPasswordBody = (await missingPassword.json()) as {
      error: { code: string }
    }
    expect(missingPasswordBody.error.code).toBe('VALIDATION_ERROR')
  })
})
