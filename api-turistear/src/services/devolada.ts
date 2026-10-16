import { z } from 'zod'

// devolada-transfer-verification D5 — the ONLY code that calls Devolada (constitution VIII), its
// unauthenticated key set included. Contract: specs/006-devolada-transfer-verification/contracts/
// devolada-collections-v1.openapi.yaml; how we use it and what breaks when it is down:
// contracts/devolada-integration.md.
//
// - Every call carries an AbortSignal.timeout: 3 s on the seller's checkout and settle path
//   (`fast`), 8 s everywhere else (SC-006 allows 5 s at checkout).
// - Every call parses the `{success, data|error}` envelope and RETURNS a typed result instead of
//   throwing: each caller has its own fallback to choose (D6, D9, D12).
// - Instants are converted here, in both directions: callers pass and receive epoch SECONDS;
//   Devolada sends and receives milliseconds.
// - The API key travels only in the Authorization header. Nothing here logs.

export type DevoladaFailureKind = 'refused' | 'retryable' | 'timeout'

export type DevoladaFailure = {
  ok: false
  kind: DevoladaFailureKind
  // Devolada's error code (AUTHENTICATION_ERROR, BUSINESS_SUSPENDED, CHANNEL_UNAVAILABLE, …), or
  // ours for what never reached an answer: NETWORK_ERROR, TIMEOUT, INVALID_RESPONSE.
  code: string
  message: string | null
  status: number | null
  retryAfter?: number
}

export type DevoladaResult<T> = { ok: true; data: T; status: number; replayed: boolean } | DevoladaFailure

// ─── Shapes, as this module returns them (seconds, not milliseconds) ─────────────────────────────

const msToSec = (ms: number): number => Math.floor(ms / 1000)
const msToSecOrNull = (ms: number | null | undefined): number | null => (ms == null ? null : msToSec(ms))

const paymentLinkSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().min(1),
    customerRef: z.string(),
    askCents: z.number().int(),
    mode: z.enum(['reusable', 'one_time']),
    expiresAt: z.number().nullable(),
    state: z.enum(['open', 'paid', 'expired']),
    closedAt: z.number().nullable().optional(),
    label: z.string().nullable().optional(),
    concept: z.string().nullable().optional(),
    isTest: z.boolean(),
    createdAt: z.number(),
    notices: z.array(z.object({ code: z.string() })).optional().default([]),
    payerReference: z.string().nullable().optional(),
  })
  .transform((l) => ({
    id: l.id,
    url: l.url,
    customerRef: l.customerRef,
    askCents: l.askCents,
    mode: l.mode,
    expiresAt: msToSecOrNull(l.expiresAt),
    state: l.state,
    closedAt: msToSecOrNull(l.closedAt),
    label: l.label ?? null,
    concept: l.concept ?? null,
    isTest: l.isTest,
    createdAt: msToSec(l.createdAt),
    notices: l.notices.map((n) => n.code),
    payerReference: l.payerReference ?? null,
  }))

export type DevoladaPaymentLink = z.output<typeof paymentLinkSchema>

export const DEVOLADA_PAYMENT_STATUS_VALUES = [
  'validating',
  'queued_for_credit',
  'confirmed',
  'partial',
  'unapplied',
  'invalid',
  'expired',
  'superseded',
] as const

const paymentSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(DEVOLADA_PAYMENT_STATUS_VALUES),
    createdAt: z.number(),
    awaiting: z.enum(['payer_tracking_key']).nullable().optional(),
    awaitingReason: z.enum(['all_used', 'ambiguous', 'no_match', 'unreadable']).nullable().optional(),
    paymentLinkId: z.string().min(1),
    customerRef: z.string(),
    askedCents: z.number().int(),
    claimedCents: z.number().int().nullable().optional(),
    proofDoor: z.enum(['transfer', 'receipt']),
    receivedCents: z.number().int().nullable().optional(),
    match: z.enum(['exact', 'short', 'over']).nullable().optional(),
    folio: z.string().nullable().optional(),
    confirmedAt: z.number().nullable().optional(),
    isTest: z.boolean(),
  })
  .transform((p) => ({
    id: p.id,
    status: p.status,
    createdAt: msToSec(p.createdAt),
    awaiting: p.awaiting ?? null,
    awaitingReason: p.awaitingReason ?? null,
    paymentLinkId: p.paymentLinkId,
    customerRef: p.customerRef,
    askedCents: p.askedCents,
    claimedCents: p.claimedCents ?? null,
    proofDoor: p.proofDoor,
    receivedCents: p.receivedCents ?? null,
    match: p.match ?? null,
    // Devolada's receipt number (DV-…). Shown as «Comprobante Devolada», never as "folio" (FR-022).
    receiptNumber: p.folio ?? null,
    confirmedAt: msToSecOrNull(p.confirmedAt),
    isTest: p.isTest,
  }))

export type DevoladaPaymentRead = z.output<typeof paymentSchema>

const webhookEndpointSchema = z
  .object({
    url: z.string(),
    createdAt: z.number(),
    consecutiveFailures: z.number().int(),
    lastFailureAt: z.number().nullable().optional(),
    lastSuccessAt: z.number().nullable().optional(),
  })
  .transform((w) => ({
    url: w.url,
    createdAt: msToSec(w.createdAt),
    consecutiveFailures: w.consecutiveFailures,
    lastFailureAt: msToSecOrNull(w.lastFailureAt),
    lastSuccessAt: msToSecOrNull(w.lastSuccessAt),
  }))

export type DevoladaWebhookEndpoint = z.output<typeof webhookEndpointSchema>

const deliveriesSchema = z.object({ deliveries: z.array(z.object({ id: z.string() }).passthrough()) })

const jwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  alg: z.string().optional(),
  use: z.string().optional(),
  kid: z.string().min(1),
  x: z.string().min(1),
  y: z.string().min(1),
})
const jwksSchema = z.object({ keys: z.array(jwkSchema) })

export type DevoladaJwk = z.output<typeof jwkSchema>

// ─── Transport ───────────────────────────────────────────────────────────────────────────────────

const FAST_TIMEOUT_MS = 3_000
const TIMEOUT_MS = 8_000

const errorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), retryable: z.boolean().optional(), message: z.string().optional() }),
})

const okEnvelope = z.object({ success: z.literal(true), data: z.unknown() })

// AbortSignal.timeout rejects with a DOMException named TimeoutError (AbortError on older runtimes).
const isTimeout = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

const baseUrl = (env: Pick<CloudflareBindings, 'DEVOLADA_API_BASE_URL'>): string =>
  env.DEVOLADA_API_BASE_URL.replace(/\/+$/, '')

interface CallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  path: string
  apiKey: string | null
  body?: unknown
  idempotencyKey?: string
  fast?: boolean
}

async function call<T>(
  env: Pick<CloudflareBindings, 'DEVOLADA_API_BASE_URL'>,
  opts: CallOptions,
  parse: (data: unknown) => T,
): Promise<DevoladaResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  let res: Response
  try {
    res = await fetch(`${baseUrl(env)}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.fast ? FAST_TIMEOUT_MS : TIMEOUT_MS),
    })
  } catch (err) {
    if (isTimeout(err)) return { ok: false, kind: 'timeout', code: 'TIMEOUT', message: null, status: null }
    return { ok: false, kind: 'retryable', code: 'NETWORK_ERROR', message: null, status: null }
  }

  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    if (isTimeout(err)) return { ok: false, kind: 'timeout', code: 'TIMEOUT', message: null, status: res.status }
    json = undefined
  }

  if (res.ok) {
    const env_ = okEnvelope.safeParse(json)
    if (env_.success) {
      try {
        return {
          ok: true,
          data: parse(env_.data.data),
          status: res.status,
          replayed: res.headers.get('Idempotency-Replayed') === 'true',
        }
      } catch {
        // fall through: an answer we cannot read is treated as transient
      }
    }
    return { ok: false, kind: 'retryable', code: 'INVALID_RESPONSE', message: null, status: res.status }
  }

  const failure = errorEnvelope.safeParse(json)
  const retryAfterHeader = Number(res.headers.get('Retry-After'))
  const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined
  if (failure.success) {
    const { code, retryable, message } = failure.data.error
    // contracts/devolada-integration.md § Error mapping — only RATE_LIMITED and
    // INTERNAL_SERVER_ERROR are retryable; every other code means the request must change.
    const transient = retryable === true || res.status === 429 || res.status >= 500
    return {
      ok: false,
      kind: transient ? 'retryable' : 'refused',
      code,
      message: message ?? null,
      status: res.status,
      ...(retryAfter ? { retryAfter } : {}),
    }
  }
  return {
    ok: false,
    kind: res.status >= 500 || res.status === 429 ? 'retryable' : 'refused',
    code: res.status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'INVALID_RESPONSE',
    message: null,
    status: res.status,
    ...(retryAfter ? { retryAfter } : {}),
  }
}

// ─── The client ──────────────────────────────────────────────────────────────────────────────────

export interface CreatePaymentLinkBody {
  customerRef: string
  askCents: number
  mode: 'one_time'
  /** Epoch seconds; may be in the past (the connect probe, D2). */
  expiresAt: number
  label?: string
  concept?: string
}

export const devoladaClient = (env: Pick<CloudflareBindings, 'DEVOLADA_API_BASE_URL'>, apiKey: string) => ({
  createPaymentLink: (body: CreatePaymentLinkBody, opts: { idempotencyKey: string; fast?: boolean }) =>
    call(
      env,
      {
        method: 'POST',
        path: '/v1/payment-links',
        apiKey,
        idempotencyKey: opts.idempotencyKey,
        fast: opts.fast,
        body: {
          customerRef: body.customerRef,
          askCents: body.askCents,
          mode: body.mode,
          expiresAt: body.expiresAt * 1000,
          ...(body.label ? { label: body.label.slice(0, 120) } : {}),
          ...(body.concept ? { concept: body.concept.slice(0, 200) } : {}),
        },
      },
      (data) => paymentLinkSchema.parse(data),
    ),

  // D13 — closing an already paid or expired one-time link answers the link as it is.
  closePaymentLink: (id: string, opts: { idempotencyKey: string }) =>
    call(
      env,
      {
        method: 'PATCH',
        path: `/v1/payment-links/${encodeURIComponent(id)}`,
        apiKey,
        idempotencyKey: opts.idempotencyKey,
        body: { close: true },
      },
      (data) => paymentLinkSchema.parse(data),
    ),

  // D21 — whether this credential can read a link another (retired) credential created.
  getPaymentLink: (id: string) =>
    call(
      env,
      { method: 'GET', path: `/v1/payment-links/${encodeURIComponent(id)}`, apiKey },
      (data) => paymentLinkSchema.parse(data),
    ),

  // D4 — the re-read a webhook is applied from. NOT_FOUND = another business's, or another mode.
  getPayment: (id: string) =>
    call(
      env,
      { method: 'GET', path: `/v1/payments/${encodeURIComponent(id)}`, apiKey },
      (data) => paymentSchema.parse(data),
    ),

  // D12 — every payment of every link of one sale (customerRef = folio id), newest first.
  listPaymentsByCustomer: (customerRef: string) =>
    call(
      env,
      { method: 'GET', path: `/v1/payments?customerRef=${encodeURIComponent(customerRef)}`, apiKey },
      (data) => z.object({ payments: z.array(paymentSchema) }).parse(data).payments,
    ),

  // D3 — 404 means no address is registered.
  getWebhook: () =>
    call(env, { method: 'GET', path: '/v1/webhook', apiKey }, (data) => webhookEndpointSchema.parse(data)),

  putWebhook: (url: string) =>
    call(env, { method: 'PUT', path: '/v1/webhook', apiKey, body: { url } }, (data) =>
      webhookEndpointSchema.parse(data),
    ),

  // FR-005 — the health's failing-delivery count.
  listFailedDeliveries: () =>
    call(
      env,
      { method: 'GET', path: '/v1/webhook/deliveries?status=failed&limit=20', apiKey },
      (data) => deliveriesSchema.parse(data).deliveries.length,
    ),
})

export type DevoladaClient = ReturnType<typeof devoladaClient>

/**
 * D4, D5 — Devolada's public signing keys: no credential and no envelope. Honours Cache-Control's
 * max-age as the caller's cache horizon (seconds; 300 when absent).
 */
export async function getSigningKeys(
  env: Pick<CloudflareBindings, 'DEVOLADA_API_BASE_URL'>,
): Promise<{ ok: true; keys: DevoladaJwk[]; maxAge: number } | { ok: false }> {
  try {
    const res = await fetch(`${baseUrl(env)}/.well-known/jwks.json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false }
    const parsed = jwksSchema.safeParse(await res.json())
    if (!parsed.success) return { ok: false }
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '')?.[1] ?? 300)
    return { ok: true, keys: parsed.data.keys, maxAge: Number.isFinite(maxAge) ? maxAge : 300 }
  } catch {
    return { ok: false }
  }
}
