import type { UserPayload } from '../features/auth/types'
import { queryClient } from '../config/queryClient'

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

  queryClient.removeQueries({ queryKey: ['me'] })

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

  queryClient.removeQueries({ queryKey: ['me'] })

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

// --- Onboarding API functions ---
//
// passkey-auth D2 — what Better Auth cannot know (an organization, an invitation) is ours, under
// /api/onboarding/* and the `{ error: { code, message } }` envelope. Signing in, signing out and
// llaves de acceso go through Better Auth's client instead (services/authClient.ts).

export interface RegisterInput {
  name: string
  email: string
  company_name: string
  phone: string
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

export interface AcceptInvitationResponse {
  /** The invited address: the sign-in code went there (D11). */
  email: string
}

// passkey-auth US3, D10 — creates the organization and its admin, and sends the sign-in code.
export const register = (data: RegisterInput) =>
  request<MessageResponse>('/api/onboarding/register', {
    method: 'POST',
    body: JSON.stringify(data),
  })

// passkey-auth US4 — the invitation lookup, moved from /api/auth/invite/accept.
export const getInvitation = (token: string) =>
  request<InviteResponse>(`/api/onboarding/invitations/${encodeURIComponent(token)}`)

// passkey-auth US4, D11 — creates the agent, consumes the invitation and sends the sign-in code.
export const acceptInvitation = (token: string, name: string) =>
  request<AcceptInvitationResponse>(
    `/api/onboarding/invitations/${encodeURIComponent(token)}/accept`,
    { method: 'POST', body: JSON.stringify({ name }) },
  )

export const getMe = async (): Promise<UserPayload> => {
  const res = await request<{ user: UserPayload }>('/api/me')
  return res.user
}
