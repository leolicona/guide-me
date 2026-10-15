// passkey-auth D17 — the HTTP side of the auth tests: a cookie jar, Resend stood in for at its
// origin (constitution VI), and the real Better Auth ceremonies driven over SELF.fetch.
import { env, SELF } from 'cloudflare:test'
import { vi } from 'vitest'
import { createCredential, getAssertion, type SoftCredential } from './authenticator'

export const API = 'http://api.local/api'
export const AUTH = `${API}/auth`

// Storage is shared by the tests of a file; the auth tables are cleared alongside the tenancy
// ones. Sessions and passkeys also go with their users (ON DELETE CASCADE).
export const clearAuthDb = async () => {
  await env.DB.exec('DELETE FROM rate_limits')
  await env.DB.exec('DELETE FROM verifications')
  await env.DB.exec('DELETE FROM passkeys')
  await env.DB.exec('DELETE FROM sessions')
}

// ─── Cookies ───────────────────────────────────────────────────────────────────────────────────
// Folds a response's Set-Cookie into a Cookie header: new values replace old ones, and an expired
// cookie (Max-Age=0) is dropped, as a browser would.
export const withCookies = (cookie: string, res: Response): string => {
  const jar = new Map(
    cookie
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)] as const),
  )
  for (const set of res.headers.getSetCookie()) {
    const [pair] = set.split(';')
    const name = pair!.slice(0, pair!.indexOf('='))
    const value = pair!.slice(pair!.indexOf('=') + 1)
    if (/max-age=0/i.test(set) || value === '') jar.delete(name)
    else jar.set(name, value)
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

export const sessionTokenOf = (cookie: string): string | null => {
  const m = cookie.match(/__Secure-gm-test\.session_token=([^;]+)/)
  if (!m) return null
  const decoded = decodeURIComponent(m[1]!)
  return decoded.slice(0, decoded.lastIndexOf('.'))
}

// ─── Resend, stood in for at its origin ────────────────────────────────────────────────────────
export interface SentEmail {
  to: string
  subject: string
  html: string
}

export const stubResend = (opts: { fail?: boolean } = {}) => {
  const sent: SentEmail[] = []
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://api.resend.com/')) {
      if (opts.fail) return new Response('Mock Error', { status: 500 })
      const body = JSON.parse(String(init?.body ?? '{}'))
      sent.push({ to: body.to, subject: body.subject, html: body.html })
      return new Response(JSON.stringify({ id: 'mock-id' }), { status: 200 })
    }
    return realFetch(input, init)
  })
  env.RESEND_API_KEY = 'test-key'
  env.RESEND_FROM = 'no-reply@turistearya.com'
  return sent
}

// Sends run in the background (D7), so wait for the email to reach the stand-in.
export const waitForEmails = async (sent: SentEmail[], count: number) => {
  await vi.waitFor(() => {
    if (sent.length < count) throw new Error(`waiting for ${count} emails, got ${sent.length}`)
  })
  return sent
}

export const codeIn = (email: SentEmail): string => {
  const m = email.subject.match(/(\d{6})$/)
  if (!m) throw new Error(`no code in "${email.subject}"`)
  return m[1]!
}

// ─── Requests ──────────────────────────────────────────────────────────────────────────────────
// A POST as the app's browser sends it: with the app's Origin. Better Auth refuses a cookie-bearing
// POST from any other origin (its CSRF check), so the tests send the real one unless they say not.
export const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${AUTH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: env.APP_BASE_URL, ...headers },
    body: JSON.stringify(body),
  })

// ─── Email code ────────────────────────────────────────────────────────────────────────────────

export const requestCode = (email: string, headers: Record<string, string> = {}) =>
  post('/email-otp/send-verification-otp', { email, type: 'sign-in' }, headers)

export const signInWithCode = (email: string, otp: string, headers: Record<string, string> = {}) =>
  post('/sign-in/email-otp', { email, otp }, headers)

// Requests a code, reads it from the stand-in and redeems it: the cookie of a fresh session.
export const signInByEmail = async (sent: SentEmail[], email: string): Promise<string> => {
  const before = sent.length
  const req = await requestCode(email)
  if (req.status !== 200) throw new Error(`send-verification-otp → ${req.status}`)
  const [mail] = (await waitForEmails(sent, before + 1)).slice(before)
  const res = await signInWithCode(email, codeIn(mail!))
  if (res.status !== 200) throw new Error(`sign-in/email-otp → ${res.status} ${await res.text()}`)
  return withCookies('', res)
}

// ─── Llaves de acceso ──────────────────────────────────────────────────────────────────────────
export const appOrigin = () => env.APP_BASE_URL

// Registration on a signed-in cookie. Answers the verify response, the authenticator's credential,
// and the cookie with the challenge cookie consumed.
export const registerPasskey = async (
  cookie: string,
  opts: { name?: string; origin?: string; counter?: number } = {},
) => {
  const optionsRes = await SELF.fetch(`${AUTH}/passkey/generate-register-options`, {
    headers: { Cookie: cookie },
  })
  if (optionsRes.status !== 200) {
    return { res: optionsRes, credential: null as SoftCredential | null, cookie }
  }
  const options = (await optionsRes.json()) as Parameters<typeof createCredential>[0]
  const withChallenge = withCookies(cookie, optionsRes)
  const { response, credential } = await createCredential(options, {
    origin: opts.origin ?? appOrigin(),
    counter: opts.counter,
  })
  const res = await post(
    '/passkey/verify-registration',
    { response, name: opts.name },
    { Cookie: withChallenge },
  )
  return { res, credential, cookie: withCookies(withChallenge, res) }
}

// A discoverable sign-in: no email, no session — only the device's credential.
export const signInWithPasskey = async (
  credential: SoftCredential,
  opts: { origin?: string; counter?: number; rpId?: string } = {},
) => {
  const optionsRes = await SELF.fetch(`${AUTH}/passkey/generate-authenticate-options`)
  const options = (await optionsRes.json()) as { challenge: string; rpId?: string }
  const challengeCookie = withCookies('', optionsRes)
  const response = await getAssertion(
    { ...options, rpId: opts.rpId ?? options.rpId },
    credential,
    { origin: opts.origin ?? appOrigin(), counter: opts.counter },
  )
  const res = await post('/passkey/verify-authentication', { response }, { Cookie: challengeCookie })
  return { res, options, cookie: withCookies('', res) }
}

// No answer under /api/auth/* may carry the session token (constitution IV v1.2.1, BFF).
export const expectNoToken = (body: unknown) => {
  const text = JSON.stringify(body)
  if (/"token"\s*:/.test(text)) throw new Error(`a session token leaked into the body: ${text}`)
}
