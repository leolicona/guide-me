// passkey-auth D17, R12 — a session the way production gets one.
//
// test/helpers/apply-migrations.ts installs a TEST-ONLY trigger that gives every inserted user a
// `sessions` row whose token is `test-session-<email>`. This helper signs that token exactly as
// Better Auth signs its cookie (better-call: `encodeURIComponent(token + '.' +
// base64(HMAC-SHA256(secret, token)))`), with the secret and prefix pinned in vitest.config.ts. So
// the business middleware reads a real row and verifies a real signature — and the 61 business
// suites keep a synchronous one-liner: `headers: { Cookie: sessionCookie(email) }`.
//
// Assertions that count or look up sessions must exclude `token LIKE 'test-session-%'`.
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'

// vitest.config.ts → miniflare bindings.
export const TEST_AUTH_SECRET = 'test_better_auth_secret_0123456789abcdef'
export const SESSION_COOKIE_NAME = '__Secure-gm-test.session_token'

export const fixtureSessionToken = (email: string): string => `test-session-${email}`

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

export const signSessionToken = (token: string, secret = TEST_AUTH_SECRET): string =>
  encodeURIComponent(`${token}.${base64(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(token)))}`)

// A cookie for any session token, e.g. one read back from a real sign-in.
export const sessionCookieFor = (token: string, secret = TEST_AUTH_SECRET): string =>
  `${SESSION_COOKIE_NAME}=${signSessionToken(token, secret)}`

// The fixture session of the user with this email (the trigger wrote it when the user was seeded).
export const sessionCookie = (email: string): string => sessionCookieFor(fixtureSessionToken(email))
