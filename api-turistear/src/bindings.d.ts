interface CloudflareBindings {
  DB: D1Database
  RESEND_API_KEY: string
  RESEND_FROM: string
  QR_SECRET: string
  API_BASE_URL: string
  APP_BASE_URL: string
  COOKIE_DOMAIN: string
  CORS_ORIGIN: string
  // passkey-auth D5 — signs the session cookie and encrypts stored sign-in codes. A Worker secret,
  // different in each environment (constitution VIII).
  BETTER_AUTH_SECRET: string
  // passkey-auth D5 — the session cookie is `__Secure-<prefix>.session_token`, one prefix per env.
  AUTH_COOKIE_PREFIX: string
  // passkey-auth D7, FR-064 — local only: 'true' prints sign-in codes instead of emailing them.
  OTP_LOG_TO_CONSOLE?: string
}
