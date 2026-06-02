import { ApiError } from '../types/errors'

type AuthSuccess<T> = { success: true; data: T }
type AuthError = { success: false; error?: { code?: string; message?: string } }
type AuthResponse<T> = AuthSuccess<T> | AuthError

const callAuth = async <T>(
  env: CloudflareBindings,
  path: string,
  body: unknown,
): Promise<T> => {
  const res = await env.AGNOSTIC_AUTH_API.fetch(`http://auth.local${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const json = (await res.json()) as AuthResponse<T>

  if (!res.ok || !json.success) {
    const err = (json as AuthError).error
    throw new ApiError(
      'INTERNAL_ERROR',
      502,
      `Agnostic Auth error (${path}): ${err?.message ?? res.statusText}`,
    )
  }

  return json.data
}

export const hashPassword = (env: CloudflareBindings, password: string) =>
  callAuth<{ hash: string; salt: string }>(env, '/auth/hash', { password })

export const initiateMagicLink = (env: CloudflareBindings, identity: string) =>
  callAuth<{ token: string; magicLink: string }>(env, '/auth/initiate', {
    appId: env.AGNOSTIC_AUTH_APP_ID,
    identity,
  })

export const verifyToken = async (
  env: CloudflareBindings,
  token: string,
): Promise<{ jwt: string; refreshToken: string }> => {
  const res = await env.AGNOSTIC_AUTH_API.fetch('http://auth.local/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: env.AGNOSTIC_AUTH_APP_ID, token }),
  })

  const json = (await res.json()) as AuthResponse<{ jwt: string; refreshToken: string }>

  if (!res.ok || !json.success) {
    throw new ApiError('INVALID_TOKEN', 400, 'Invalid or expired verification token')
  }

  return json.data
}

interface VerifyPasswordInput {
  password: string
  hash: string
  salt: string
  identity: string
}

export const verifyPassword = async (
  env: CloudflareBindings,
  input: VerifyPasswordInput,
): Promise<{ jwt: string; refreshToken: string }> => {
  const res = await env.AGNOSTIC_AUTH_API.fetch(
    'http://auth.local/auth/verify-password',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: env.AGNOSTIC_AUTH_APP_ID,
        identity: input.identity,
        attemptedPassword: input.password,
        storedHash: input.hash,
        storedSalt: input.salt,
      }),
    },
  )

  const json = (await res.json()) as AuthResponse<{ jwt: string; refreshToken: string }>

  if (!res.ok || !json.success) {
    throw new ApiError('INVALID_CREDENTIALS', 401, 'Invalid email or password')
  }

  return json.data
}

export const refreshTokens = async (
  env: CloudflareBindings,
  refreshToken: string,
): Promise<{ jwt: string; refreshToken: string }> => {
  const res = await env.AGNOSTIC_AUTH_API.fetch('http://auth.local/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: env.AGNOSTIC_AUTH_APP_ID, refreshToken }),
  })

  const json = (await res.json()) as AuthResponse<{ jwt: string; refreshToken: string }>

  if (!res.ok || !json.success) {
    throw new ApiError('UNAUTHORIZED', 401, 'Invalid or expired refresh token')
  }

  return json.data
}

export const revokeToken = async (
  env: CloudflareBindings,
  refreshToken: string,
): Promise<void> => {
  try {
    await env.AGNOSTIC_AUTH_API.fetch('http://auth.local/auth/token/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: env.AGNOSTIC_AUTH_APP_ID, refreshToken }),
    })
  } catch (err) {
    console.error('Failed to revoke token:', err)
  }
}
