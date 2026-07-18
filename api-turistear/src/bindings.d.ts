interface CloudflareBindings {
  DB: D1Database
  AGNOSTIC_AUTH_API: Fetcher
  AGNOSTIC_AUTH_APP_ID: string
  RESEND_API_KEY: string
  RESEND_FROM: string
  QR_SECRET: string
  API_BASE_URL: string
  APP_BASE_URL: string
  COOKIE_DOMAIN: string
  CORS_ORIGIN: string
  // Local-dev only: when set (in .dev.vars), auth calls go to this deployed
  // agnostic-auth URL over HTTPS instead of the AGNOSTIC_AUTH_API binding.
  DEV_AUTH_SERVICE_URL?: string
}
