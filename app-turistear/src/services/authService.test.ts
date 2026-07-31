import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { request, ServiceError, login, getMe } from './authService'
import { queryClient } from '../config/queryClient'

// The global interceptor. It runs on EVERY request the app makes, it decides whether a 401 means
// "your session ended" or "that password was wrong", and getting that distinction backwards is
// BUG-017's neighbourhood. None of it is reachable from a component test.

/** A `Response`-shaped stub — enough surface for `request` without pulling in undici. */
const res = (init: {
  ok?: boolean
  status?: number
  statusText?: string
  json?: () => Promise<unknown>
}) =>
  ({
    ok: init.ok ?? false,
    status: init.status ?? 200,
    statusText: init.statusText ?? '',
    json: init.json ?? (() => Promise.resolve({})),
  }) as Response

const jsonOk = (body: unknown) => res({ ok: true, status: 200, json: () => Promise.resolve(body) })

const errorBody = (status: number, code: string, message: string) =>
  res({ status, json: () => Promise.resolve({ error: { code, message } }) })

let fetchMock: ReturnType<typeof vi.fn>
let replace: ReturnType<typeof vi.fn>
let removeQueries: ReturnType<typeof vi.spyOn>
const realLocation = window.location

/** Point `window.location` at a stub so the redirect can be asserted without navigating jsdom. */
function stubLocation(pathname: string, search = '') {
  replace = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { pathname, search, href: `http://localhost${pathname}${search}`, replace },
  })
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  removeQueries = vi.spyOn(queryClient, 'removeQueries').mockImplementation(() => {})
  stubLocation('/pos')
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  })
})

describe('request — the happy path', () => {
  it('returns the parsed body', async () => {
    fetchMock.mockResolvedValue(jsonOk({ ok: true }))
    await expect(request('/api/me')).resolves.toEqual({ ok: true })
  })

  it('always sends cookies — the session lives in httpOnly cookies, not a header', async () => {
    fetchMock.mockResolvedValue(jsonOk({}))
    await request('/api/me')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' })
  })

  it('sets the JSON content type only when there is a body to describe', async () => {
    fetchMock.mockResolvedValue(jsonOk({}))

    await request('/api/me')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({})

    await request('/api/thing', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      'Content-Type': 'application/json',
    })
  })

  it('lets a caller override the headers it passes', async () => {
    fetchMock.mockResolvedValue(jsonOk({}))
    await request('/api/thing', { headers: { 'X-Trace': 'abc' } })
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-Trace': 'abc' })
  })
})

describe('request — error decoding', () => {
  it('lifts the API error envelope into a typed ServiceError', async () => {
    fetchMock.mockResolvedValue(errorBody(409, 'SEASON_OVERLAP', 'Las temporadas se traslapan'))

    const error = await request('/api/catalog/seasons').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceError)
    expect(error).toMatchObject({
      code: 'SEASON_OVERLAP',
      status: 409,
      message: 'Las temporadas se traslapan',
      name: 'ServiceError',
    })
  })

  it('falls back to UNKNOWN + statusText on a non-JSON body, instead of throwing a parse error', async () => {
    // A Cloudflare 502 is an HTML page. The user must still get the app's error UI, not a
    // SyntaxError from deep inside a service client.
    fetchMock.mockResolvedValue(
      res({
        status: 502,
        statusText: 'Bad Gateway',
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      }),
    )

    const error = await request('/api/me').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceError)
    expect(error).toMatchObject({ code: 'UNKNOWN', status: 502, message: 'Bad Gateway' })
  })

  it('falls back field by field when the envelope is partial', async () => {
    fetchMock.mockResolvedValue(
      res({ status: 400, statusText: 'Bad Request', json: () => Promise.resolve({ error: {} }) }),
    )
    const error = await request('/api/me').catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'UNKNOWN', message: 'Bad Request' })
  })
})

describe('request — 401 on a protected path means the session ended', () => {
  it('drops the cached session and bounces to login with a return path', async () => {
    stubLocation('/pos/folio/abc', '?tab=pagos')
    fetchMock.mockResolvedValue(errorBody(401, 'UNAUTHORIZED', 'No autorizado'))

    await expect(request('/api/pos/folios/abc')).rejects.toBeInstanceOf(ServiceError)

    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['me'] })
    expect(replace).toHaveBeenCalledWith(
      `/login?redirect=${encodeURIComponent('/pos/folio/abc?tab=pagos')}`,
    )
  })

  it('encodes the return path so query params survive the round trip', async () => {
    stubLocation('/reports', '?from=2026-08-01&to=2026-08-31')
    fetchMock.mockResolvedValue(errorBody(401, 'UNAUTHORIZED', 'No autorizado'))

    await request('/api/reports').catch(() => {})
    const target = replace.mock.calls[0][0] as string
    expect(new URL(target, 'http://x').searchParams.get('redirect')).toBe(
      '/reports?from=2026-08-01&to=2026-08-31',
    )
  })

  it('does not redirect when already on /login — the loop guard', async () => {
    stubLocation('/login')
    fetchMock.mockResolvedValue(errorBody(401, 'UNAUTHORIZED', 'No autorizado'))

    await request('/api/me').catch(() => {})
    expect(replace).not.toHaveBeenCalled()
    // The stale session is still evicted, even without the navigation.
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['me'] })
  })
})

describe('request — 401 on a public auth path is a domain error, not an expired session', () => {
  it('never bounces on a wrong password: the login form must show the message', async () => {
    stubLocation('/login')
    fetchMock.mockResolvedValue(errorBody(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas'))

    const error = await login({ email: 'ana@example.com', password: 'wrong' }).catch(
      (e: unknown) => e,
    )

    expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS' })
    expect(replace).not.toHaveBeenCalled()
    expect(removeQueries).not.toHaveBeenCalled()
  })

  it.each([
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/auth/invite/complete',
  ])('exempts %s from the interceptor', async (path) => {
    fetchMock.mockResolvedValue(errorBody(401, 'INVALID_TOKEN', 'Token inválido'))
    await request(path, { method: 'POST' }).catch(() => {})
    expect(replace).not.toHaveBeenCalled()
  })

  it('still bounces on /api/me, which is protected despite living near the auth routes', async () => {
    fetchMock.mockResolvedValue(errorBody(401, 'UNAUTHORIZED', 'No autorizado'))
    await getMe().catch(() => {})
    expect(replace).toHaveBeenCalled()
  })
})

describe('request — a suspended account (US-A08)', () => {
  it('bounces to login with a reason, and no way back', async () => {
    stubLocation('/pos')
    fetchMock.mockResolvedValue(errorBody(403, 'ACCOUNT_SUSPENDED', 'Cuenta suspendida'))

    await expect(request('/api/pos/services')).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' })

    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['me'] })
    // No `redirect=`: a suspended user cannot return to where they were.
    expect(replace).toHaveBeenCalledWith('/login?reason=suspended')
  })

  it('is idempotent once the reason is already in the URL', async () => {
    stubLocation('/login', '?reason=suspended')
    fetchMock.mockResolvedValue(errorBody(403, 'ACCOUNT_SUSPENDED', 'Cuenta suspendida'))

    await request('/api/pos/services').catch(() => {})
    expect(replace).not.toHaveBeenCalled()
  })

  it('leaves an ordinary 403 alone — a permission denial is not a suspension', async () => {
    fetchMock.mockResolvedValue(errorBody(403, 'FORBIDDEN', 'Sin permiso'))

    await expect(request('/api/admin/thing')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(replace).not.toHaveBeenCalled()
    expect(removeQueries).not.toHaveBeenCalled()
  })
})

describe('getMe', () => {
  it('folds the operator claim into the session user (US-OP01/OP02)', async () => {
    fetchMock.mockResolvedValue(
      jsonOk({ user: { id: 'u1', role: 'affiliate' }, operator: { id: 'op1', name: 'Caja 2' } }),
    )
    await expect(getMe()).resolves.toMatchObject({
      id: 'u1',
      role: 'affiliate',
      operator: { id: 'op1', name: 'Caja 2' },
    })
  })

  it('normalises a missing operator to null, never undefined', async () => {
    fetchMock.mockResolvedValue(jsonOk({ user: { id: 'u1', role: 'admin' } }))
    await expect(getMe()).resolves.toMatchObject({ operator: null })
  })
})
