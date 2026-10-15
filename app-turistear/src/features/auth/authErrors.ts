// passkey-auth FR-070 — /api/auth/* answers in Better Auth's format, `{ code, message }`, and its
// client hands that back as `{ data, error }` with `status` added. The app branches on `code` (or on
// HTTP 429), never on `message` (constitution IV): these are the codes the spec declares.

/** The error half of a Better Auth client result. `code` is absent on a 429. */
export interface AuthClientErrorShape {
  code?: string
  message?: string
  status: number
  statusText?: string
}

export class AuthError extends Error {
  readonly code: string | null
  readonly status: number
  /** Seconds Better Auth asks us to wait (`X-Retry-After`, D9) — set only on a 429. */
  readonly retryAfter: number | null

  constructor(code: string | null, status: number, message: string, retryAfter: number | null) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

export const toAuthError = (error: AuthClientErrorShape, retryAfter: number | null = null) =>
  new AuthError(error.code ?? null, error.status, error.message ?? '', retryAfter)

/**
 * Reads Better Auth's `X-Retry-After` off a refused call (FR-012). The API's CORS exposes the
 * header (D9); the client drops headers from its `{ data, error }`, so it is caught in `onError`.
 */
export function retryAfterProbe() {
  let seconds: number | null = null
  return {
    onError(ctx: { response: Response }) {
      const value = Number(ctx.response.headers.get('X-Retry-After'))
      seconds = Number.isFinite(value) && value > 0 ? Math.ceil(value) : null
    },
    get seconds() {
      return seconds
    },
  }
}

// passkey-auth US2 (scenario 6) — the person closed the device's prompt, or a newer ceremony
// replaced this one. The passkey client folds the browser's NotAllowedError / AbortError into
// these codes (it keeps the WebAuthn code, not the DOMException name), and the app returns to where
// it was without a word.
const CANCELLED = new Set([
  'ERROR_CEREMONY_ABORTED',
  'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
  'AUTH_CANCELLED',
])

export const isCancelled = (error: AuthError) => error.code !== null && CANCELLED.has(error.code)

const MESSAGES: Record<string, string> = {
  INVALID_OTP: 'El código no es correcto. Revísalo e inténtalo de nuevo.',
  OTP_EXPIRED: 'El código venció. Pide uno nuevo.',
  TOO_MANY_ATTEMPTS: 'Demasiados intentos con este código. Pide uno nuevo.',
  ACCOUNT_SUSPENDED: 'Tu cuenta ha sido suspendida. Contacta a tu administrador.',
  PASSKEY_NOT_FOUND: 'No reconocemos esa llave de acceso. Entra con un código por correo.',
  AUTHENTICATION_FAILED: 'No pudimos verificar tu llave de acceso. Entra con un código por correo.',
  CHALLENGE_NOT_FOUND: 'La solicitud venció. Inténtalo de nuevo.',
  SESSION_NOT_FRESH: 'Por seguridad, vuelve a entrar antes de crear una llave de acceso.',
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: 'Esta llave de acceso ya está guardada en tu cuenta.',
}

/** The es-MX sentence for any failure of an auth call, keyed on the code. */
export function authErrorMessage(error: unknown): string {
  if (!(error instanceof AuthError)) {
    // fetch itself rejected: no answer reached us.
    return 'No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.'
  }
  if (error.status === 429) {
    return error.retryAfter
      ? `Demasiados intentos. Espera ${error.retryAfter} segundos e inténtalo de nuevo.`
      : 'Demasiados intentos. Espera un momento e inténtalo de nuevo.'
  }
  if (error.code && error.code in MESSAGES) return MESSAGES[error.code]
  // Any other ceremony failure on the device (an unsupported option, a broken authenticator).
  if (error.code?.startsWith('ERROR_')) {
    return 'No pudimos usar tu llave de acceso. Entra con un código por correo.'
  }
  return 'Algo salió mal. Inténtalo de nuevo.'
}
