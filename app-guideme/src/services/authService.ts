import type { UserPayload } from '../features/auth/types'
import { useAuthStore } from '../store/authStore'

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

export class ServiceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.status = status
  }
}

// Endpoints where 401 is a domain error (e.g. wrong credentials on /login)
// rather than an expired session — skip the global interceptor for these.
const AUTH_PUBLIC_PREFIX = '/api/auth/'

function handleUnauthorized(path: string) {
  if (path.startsWith(AUTH_PUBLIC_PREFIX)) return
  if (typeof window === 'undefined') return

  useAuthStore.getState().clear()

  if (!window.location.pathname.startsWith('/login')) {
    const redirect = window.location.pathname + window.location.search
    window.location.replace(`/login?redirect=${encodeURIComponent(redirect)}`)
  }
}

// A suspended account (US-A08) is bounced from anywhere in the app. Unlike an
// expired session there is no `redirect` back — the user cannot return — so we
// send them to login with a reason the login screen can explain.
function handleSuspended() {
  if (typeof window === 'undefined') return

  useAuthStore.getState().clear()

  if (!window.location.search.includes('reason=suspended')) {
    window.location.replace('/login?reason=suspended')
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (res.ok) {
    return res.json() as Promise<T>
  }

  let code = 'UNKNOWN'
  let message = res.statusText
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    code = body.error?.code ?? code
    message = body.error?.message ?? message
  } catch {
    // non-JSON error body — keep defaults
  }

  if (res.status === 401) {
    handleUnauthorized(path)
  } else if (res.status === 403 && code === 'ACCOUNT_SUSPENDED') {
    handleSuspended()
  }

  throw new ServiceError(code, res.status, message)
}

// --- Auth API functions ---

export interface RegisterInput {
  name: string
  email: string
  password: string
  company_name: string
  phone: string
}

export interface LoginInput {
  email: string
  password: string
}

export interface ResetPasswordInput {
  token: string
  password: string
}

export interface CompleteInviteInput {
  token: string
  name: string
  password: string
}

export interface AuthUserResponse {
  user: { name: string; role: string }
}

export interface MessageResponse {
  message: string
}

export interface InviteResponse {
  invitation: {
    identity: string
    identity_type: string
    organization_name: string
  }
}

export const register = (data: RegisterInput) =>
  request<MessageResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const verifyEmail = (token: string) =>
  request<AuthUserResponse>(`/api/auth/verify?token=${encodeURIComponent(token)}`)

export const login = (data: LoginInput) =>
  request<AuthUserResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const forgotPassword = (email: string) =>
  request<MessageResponse>('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })

export const resetPassword = (data: ResetPasswordInput) =>
  request<MessageResponse>('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const getInvite = (token: string) =>
  request<InviteResponse>(`/api/auth/invite/accept?token=${encodeURIComponent(token)}`)

export const completeInvite = (data: CompleteInviteInput) =>
  request<AuthUserResponse>('/api/auth/invite/complete', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const getMe = async () => {
  const res = await request<{ user: UserPayload }>('/api/me')
  return res.user
}

export const logout = () =>
  request<MessageResponse>('/api/auth/logout', { method: 'POST' })
