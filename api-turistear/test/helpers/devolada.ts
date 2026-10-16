// devolada-transfer-verification D18 — a stateful fake Devolada, stood in for at its origin
// (constitution VI), emulating the v1 collections contract
// (specs/006-devolada-transfer-verification/contracts/devolada-collections-v1.openapi.yaml).
//
// `installFakeDevolada()` spies `globalThis.fetch` for `https://devolada.test` — the host the test
// config pins as DEVOLADA_API_BASE_URL, which cannot resolve, so a call the fake does not answer
// fails instead of reaching Devolada (D17) — and passes every other URL through. It CHAINS to the
// spy's current implementation instead of replacing it: a test that called `stubResend()` first
// still captures the ticket emails. Call `vi.restoreAllMocks()` in `afterEach`.
//
// Time is Devolada's: milliseconds, read from the suite's frozen Date (apply-migrations.ts).
import { vi } from 'vitest'
import { resetSigningKeyCache } from '../../src/utils/devoladaSignature'

export const DEVOLADA_ORIGIN = 'https://devolada.test'
export const WEBHOOK_URL_OF_THIS_API = 'https://api.test/api/webhooks/devolada' // vitest.config.ts
export const WEBHOOK_REQUEST_URL = 'http://api.local/api/webhooks/devolada'
export const SIGNING_KEY_ID = 'test-2026-a'

export type FakeMode = 'real' | 'test'
export type FakeChannel = 'ok' | 'clabe' | 'bank'
export type FakePaymentStatus =
  | 'validating'
  | 'queued_for_credit'
  | 'confirmed'
  | 'partial'
  | 'unapplied'
  | 'invalid'
  | 'expired'
  | 'superseded'
export type FakeRoute =
  | 'createPaymentLink'
  | 'getPaymentLink'
  | 'closePaymentLink'
  | 'listPayments'
  | 'getPayment'
  | 'getWebhook'
  | 'putWebhook'
  | 'deleteWebhook'
  | 'listDeliveries'
  | 'jwks'
export type FailMode = 'timeout' | '500' | 'rate_limited' | 'unreachable'

const FINAL: ReadonlySet<FakePaymentStatus> = new Set([
  'confirmed',
  'partial',
  'unapplied',
  'invalid',
  'expired',
  'superseded',
])

interface FakeKey {
  apiKey: string
  businessId: string
  mode: FakeMode
  revoked: boolean
}

export interface FakeWebhook {
  url: string
  createdAt: number
  consecutiveFailures: number
  lastFailureAt: number | null
  lastSuccessAt: number | null
}

export interface FakeBusiness {
  id: string
  channel: FakeChannel
  suspended: boolean
  webhook: FakeWebhook | null
  failedDeliveries: number
  idempotency: Map<string, { status: number; payload: unknown }>
}

export interface FakeLink {
  id: string
  businessId: string
  mode: FakeMode
  customerRef: string
  askCents: number
  expiresAt: number
  closedAt: number | null
  paid: boolean
  label: string | null
  concept: string | null
  createdAt: number
  url: string
  notices: string[]
}

export interface FakePayment {
  id: string
  businessId: string
  linkId: string
  mode: FakeMode
  status: FakePaymentStatus
  createdAt: number
  awaiting: 'payer_tracking_key' | null
  awaitingReason: 'all_used' | 'ambiguous' | 'no_match' | 'unreadable' | null
  askedCents: number
  claimedCents: number | null
  proofDoor: 'transfer' | 'receipt'
  receivedCents: number | null
  match: 'exact' | 'short' | 'over' | null
  folio: string | null
  confirmedAt: number | null
}

export interface FakeCall {
  route: FakeRoute | 'unknown'
  method: string
  path: string
  apiKey: string | null
  idempotencyKey: string | null
  body: unknown
}

const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

const enc = new TextEncoder()
const b64url = (buf: ArrayBuffer): string => {
  let bin = ''
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// One signing key pair per isolate, under one fixed kid: a key cached by the API under that kid is
// always the right one, whichever test cached it. `wrongKey` signs with a second pair.
let signingPairs: Promise<{ main: CryptoKeyPair; other: CryptoKeyPair; publicJwk: JsonWebKey }> | null =
  null
const keyPairs = () => {
  signingPairs ??= (async () => {
    const gen = () =>
      crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<
        CryptoKeyPair
      >
    const main = await gen()
    const other = await gen()
    const publicJwk = (await crypto.subtle.exportKey('jwk', main.publicKey)) as JsonWebKey
    return { main, other, publicJwk }
  })()
  return signingPairs
}

const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const refusal = (status: number, code: string, message?: string) => ({
  status,
  payload: {
    success: false,
    error: {
      code,
      retryable: code === 'RATE_LIMITED' || code === 'INTERNAL_SERVER_ERROR',
      ...(message ? { message } : {}),
    },
  },
})
const success = (status: number, data: unknown) => ({ status, payload: { success: true, data } })

const routeOf = (method: string, path: string): FakeRoute | 'unknown' => {
  if (path === '/.well-known/jwks.json' && method === 'GET') return 'jwks'
  if (path === '/v1/payment-links' && method === 'POST') return 'createPaymentLink'
  if (/^\/v1\/payment-links\/[^/]+$/.test(path)) {
    if (method === 'GET') return 'getPaymentLink'
    if (method === 'PATCH') return 'closePaymentLink'
  }
  if (path === '/v1/payments' && method === 'GET') return 'listPayments'
  if (/^\/v1\/payments\/[^/]+$/.test(path) && method === 'GET') return 'getPayment'
  if (path === '/v1/webhook') {
    if (method === 'GET') return 'getWebhook'
    if (method === 'PUT') return 'putWebhook'
    if (method === 'DELETE') return 'deleteWebhook'
  }
  if (path === '/v1/webhook/deliveries' && method === 'GET') return 'listDeliveries'
  return 'unknown'
}

export interface SignedEventOptions {
  eventId?: string
  keyId?: string
  /** Changes the body after signing, keeping it valid JSON: the signature no longer matches. */
  tamperBody?: boolean
  /** Signs with a key pair Devolada never published, under the published kid. */
  wrongKey?: boolean
  /** The status the BODY announces; the re-read still answers the payment's real status. */
  as?: FakePaymentStatus
  /** Overrides `data.isTest` in the body. */
  isTest?: boolean
}

export const installFakeDevolada = async () => {
  resetSigningKeyCache()
  const pairs = await keyPairs()

  const keys = new Map<string, FakeKey>()
  const businesses = new Map<string, FakeBusiness>()
  const links = new Map<string, FakeLink>()
  const payments = new Map<string, FakePayment>()
  const calls: FakeCall[] = []
  const failures = new Map<FakeRoute, FailMode[]>()
  let outage: FailMode | null = null

  const now = () => Date.now()

  const linkState = (l: FakeLink): 'open' | 'paid' | 'expired' => {
    if (l.paid) return 'paid'
    if (l.closedAt !== null || l.expiresAt <= now()) return 'expired'
    return 'open'
  }

  const wireLink = (l: FakeLink) => ({
    id: l.id,
    url: l.url,
    customerRef: l.customerRef,
    askCents: l.askCents,
    mode: 'one_time',
    expiresAt: l.expiresAt,
    state: linkState(l),
    closedAt: l.closedAt,
    label: l.label,
    concept: l.concept,
    isTest: l.mode === 'test',
    createdAt: l.createdAt,
    notices: l.notices.map((code) => ({ code })),
    payerReference: null,
  })

  const facts = (p: FakePayment) => {
    const link = links.get(p.linkId)!
    return {
      paymentLinkId: link.id,
      customerRef: link.customerRef,
      askedCents: p.askedCents,
      claimedCents: p.claimedCents,
      proofDoor: p.proofDoor,
      receivedCents: p.receivedCents,
      match: p.match,
      folio: p.folio,
      confirmedAt: p.confirmedAt,
      isTest: p.mode === 'test',
    }
  }

  const wirePayment = (p: FakePayment) => ({
    id: p.id,
    status: p.status,
    createdAt: p.createdAt,
    awaiting: p.awaiting,
    awaitingReason: p.awaitingReason,
    ...facts(p),
  })

  // The same business and mode as the credential, or NOT_FOUND (contract § NotFound).
  const visible = (key: FakeKey, row: { businessId: string; mode: FakeMode } | undefined) =>
    row !== undefined && row.businessId === key.businessId && row.mode === key.mode

  const validateCreate = (body: any): string | null => {
    if (!body || typeof body !== 'object') return 'body: Expected object'
    const ref = typeof body.customerRef === 'string' ? body.customerRef.trim() : ''
    if (ref.length < 1 || ref.length > 128) return 'customerRef: Expected 1-128 characters'
    if (!Number.isInteger(body.askCents) || body.askCents <= 0) return 'askCents: Expected a positive integer'
    const mode = body.mode ?? 'reusable'
    if (mode !== 'one_time') return 'mode: this fake only emulates one_time links'
    if (!Number.isInteger(body.expiresAt) || body.expiresAt <= 0) return 'expiresAt: Required for one_time'
    if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length < 1 || body.label.length > 120))
      return 'label: Expected 1-120 characters'
    if (
      body.concept !== undefined &&
      (typeof body.concept !== 'string' || body.concept.length < 1 || body.concept.length > 200)
    )
      return 'concept: Expected 1-200 characters'
    return null
  }

  const handle = (
    route: FakeRoute | 'unknown',
    method: string,
    url: URL,
    key: FakeKey,
    business: FakeBusiness,
    body: any,
  ): { status: number; payload: unknown } => {
    const path = url.pathname
    switch (route) {
      case 'createPaymentLink': {
        const problem = validateCreate(body)
        if (problem) return refusal(400, 'VALIDATION_ERROR', problem)
        if (business.channel !== 'ok') return refusal(409, 'CHANNEL_UNAVAILABLE', business.channel)
        const link: FakeLink = {
          id: `lnk_${hex(16)}`,
          businessId: business.id,
          mode: key.mode,
          customerRef: body.customerRef.trim(),
          askCents: body.askCents,
          expiresAt: body.expiresAt,
          closedAt: null,
          paid: false,
          label: body.label ?? null,
          concept: body.concept ?? null,
          createdAt: now(),
          url: `https://link.devolada.test/p/${hex(8)}`,
          notices: [],
        }
        links.set(link.id, link)
        return success(201, wireLink(link))
      }
      case 'getPaymentLink': {
        const link = links.get(decodeURIComponent(path.split('/').pop()!))
        if (!visible(key, link)) return refusal(404, 'NOT_FOUND')
        return success(200, wireLink(link!))
      }
      case 'closePaymentLink': {
        const link = links.get(decodeURIComponent(path.split('/').pop()!))
        if (!visible(key, link)) return refusal(404, 'NOT_FOUND')
        if (!body || body.close !== true) return refusal(400, 'VALIDATION_ERROR', 'close: Expected true')
        // Closing an already paid or expired one-time link changes nothing.
        if (linkState(link!) === 'open') link!.closedAt = now()
        return success(200, wireLink(link!))
      }
      case 'getPayment': {
        const payment = payments.get(decodeURIComponent(path.split('/').pop()!))
        if (!visible(key, payment)) return refusal(404, 'NOT_FOUND')
        return success(200, wirePayment(payment!))
      }
      case 'listPayments': {
        const ref = (url.searchParams.get('customerRef') ?? '').trim()
        if (!ref) return refusal(400, 'VALIDATION_ERROR', 'customerRef: Required')
        const found = [...payments.values()]
          .filter((p) => visible(key, p) && links.get(p.linkId)!.customerRef === ref)
          .reverse()
          .sort((a, b) => b.createdAt - a.createdAt)
        return success(200, { payments: found.map(wirePayment) })
      }
      case 'getWebhook':
        if (!business.webhook) return refusal(404, 'NOT_FOUND')
        return success(200, business.webhook)
      case 'putWebhook': {
        const target = body?.url
        if (typeof target !== 'string' || !/^https:\/\/\S+$/.test(target))
          return refusal(400, 'INSECURE_URL', 'url must be an absolute https URL')
        business.webhook = {
          url: target,
          createdAt: now(),
          consecutiveFailures: 0,
          lastFailureAt: null,
          lastSuccessAt: null,
        }
        return success(200, business.webhook)
      }
      case 'deleteWebhook': {
        const removed = business.webhook !== null
        business.webhook = null
        return success(200, { removed })
      }
      case 'listDeliveries':
        return success(200, {
          deliveries: Array.from({ length: business.failedDeliveries }, (_, i) => ({
            id: `dlv_${i}`,
            eventId: `evt_${i}`,
            type: 'payment.validating',
            paymentId: null,
            status: 'failed',
            attempts: 6,
            nextAttemptAt: null,
            responseStatus: 500,
            lastError: 'HTTP_500',
            keyId: SIGNING_KEY_ID,
            deliveredAt: null,
            createdAt: now(),
          })),
        })
      default:
        return refusal(404, 'NOT_FOUND')
    }
  }

  const answerFailure = (mode: FailMode): Response => {
    if (mode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    if (mode === 'unreachable') throw new TypeError('fetch failed')
    if (mode === 'rate_limited') {
      const r = refusal(429, 'RATE_LIMITED')
      return json(r.status, r.payload, { 'Retry-After': '30' })
    }
    const r = refusal(500, 'INTERNAL_SERVER_ERROR')
    return json(r.status, r.payload)
  }

  // Synchronous on purpose: a failure throws straight into the spy's own promise, with no inner
  // promise rejected before anything awaits it.
  const devolada = (url: URL, method: string, headers: Headers, rawBody: string | null): Response => {
    const route = routeOf(method, url.pathname)
    const auth = headers.get('Authorization')
    const apiKey = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    let body: unknown = null
    if (rawBody) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
    }
    calls.push({
      route,
      method,
      path: url.pathname + url.search,
      apiKey,
      idempotencyKey: headers.get('Idempotency-Key'),
      body,
    })

    if (outage) return answerFailure(outage)
    const queued = route === 'unknown' ? undefined : failures.get(route)
    if (queued?.length) return answerFailure(queued.shift()!)

    if (route === 'jwks') {
      return json(
        200,
        { keys: [{ ...pairs.publicJwk, kid: SIGNING_KEY_ID, alg: 'ES256', use: 'sig' }] },
        { 'Cache-Control': 'public, max-age=300' },
      )
    }

    const key = apiKey ? keys.get(apiKey) : undefined
    if (!key || key.revoked) {
      const r = refusal(401, 'AUTHENTICATION_ERROR')
      return json(r.status, r.payload)
    }
    const business = businesses.get(key.businessId)!
    const idemKey = headers.get('Idempotency-Key')
    const idempotent = (method === 'POST' || method === 'PATCH') && idemKey
    const slot = idempotent ? `${route}:${idemKey}` : null
    if (slot) {
      const first = business.idempotency.get(slot)
      if (first) return json(first.status, first.payload, { 'Idempotency-Replayed': 'true' })
    }
    const answer = business.suspended
      ? refusal(409, 'BUSINESS_SUSPENDED')
      : handle(route, method, url, key, business, body)
    // The first answer is replayed for 24 hours, refusals included (contract § IdempotencyKey).
    if (slot) business.idempotency.set(slot, answer)
    return json(answer.status, answer.payload)
  }

  // Chain to what fetch does now: stubResend's stand-in when a test installed it first, otherwise
  // the real fetch, captured before the spy replaces it.
  const current = globalThis.fetch
  let previous: typeof fetch
  if (vi.isMockFunction(current)) {
    const impl = current.getMockImplementation() as typeof fetch | undefined
    if (!impl) throw new Error('installFakeDevolada: fetch is spied without an implementation to chain to')
    previous = impl
  } else {
    previous = current
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== DEVOLADA_ORIGIN) return previous(input, init)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const rawBody =
      typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.text() : null
    return devolada(url, method, headers, rawBody)
  })

  const fake = {
    calls,
    links,
    payments,
    businesses,

    /** A Devolada business with one API key of `mode`. */
    addBusiness(opts: { mode?: FakeMode; channel?: FakeChannel; suspended?: boolean; webhookUrl?: string } = {}) {
      const business: FakeBusiness = {
        id: `biz_${hex(6)}`,
        channel: opts.channel ?? 'ok',
        suspended: opts.suspended ?? false,
        webhook: opts.webhookUrl
          ? { url: opts.webhookUrl, createdAt: now(), consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: null }
          : null,
        failedDeliveries: 0,
        idempotency: new Map(),
      }
      businesses.set(business.id, business)
      const apiKey = fake.addKey(business.id, opts.mode ?? 'test')
      return { businessId: business.id, apiKey }
    },

    /** Another key of the same business: a rotation within one business (D21). */
    addKey(businessId: string, mode: FakeMode = 'test') {
      const apiKey = `dk_${hex(16)}`
      keys.set(apiKey, { apiKey, businessId, mode, revoked: false })
      return apiKey
    },

    revokeKey(apiKey: string) {
      keys.get(apiKey)!.revoked = true
    },

    setChannel(businessId: string, channel: FakeChannel) {
      businesses.get(businessId)!.channel = channel
    },

    suspend(businessId: string, suspended = true) {
      businesses.get(businessId)!.suspended = suspended
    },

    setWebhook(businessId: string, url: string | null) {
      businesses.get(businessId)!.webhook = url
        ? { url, createdAt: now(), consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: null }
        : null
    },

    setWebhookHealth(businessId: string, health: Partial<FakeWebhook>) {
      Object.assign(businesses.get(businessId)!.webhook!, health)
    },

    setFailedDeliveries(businessId: string, count: number) {
      businesses.get(businessId)!.failedDeliveries = count
    },

    /** The next `times` calls of `route` fail this way. */
    failNext(route: FakeRoute, mode: FailMode, times = 1) {
      const queue = failures.get(route) ?? []
      for (let i = 0; i < times; i += 1) queue.push(mode)
      failures.set(route, queue)
    },

    /** Every call fails this way until `up()`. */
    down(mode: FailMode = 'unreachable') {
      outage = mode
    },

    up() {
      outage = null
    },

    callsTo(route: FakeRoute) {
      return calls.filter((c) => c.route === route)
    },

    link(devoladaLinkId: string) {
      return links.get(devoladaLinkId)!
    },

    /** The customer submits proof on a link: a `validating` payment (contract § PaymentStatus). */
    submitProof(
      devoladaLinkId: string,
      opts: { claimedCents?: number | null; proofDoor?: 'transfer' | 'receipt'; at?: number } = {},
    ) {
      const link = links.get(devoladaLinkId)
      if (!link) throw new Error(`fake Devolada: no link ${devoladaLinkId}`)
      const payment: FakePayment = {
        id: `pay_${hex(16)}`,
        businessId: link.businessId,
        linkId: link.id,
        mode: link.mode,
        status: 'validating',
        createdAt: opts.at ?? now(),
        awaiting: null,
        awaitingReason: null,
        askedCents: link.askCents,
        claimedCents: opts.claimedCents === undefined ? link.askCents : opts.claimedCents,
        proofDoor: opts.proofDoor ?? 'transfer',
        receivedCents: null,
        match: null,
        folio: null,
        confirmedAt: null,
      }
      payments.set(payment.id, payment)
      return payment.id
    },

    /**
     * The test-mode advance (contract § advanceTestPayment): `receivedCents` is read by confirmed,
     * partial and unapplied, and defaults to the ask; confirmed below the ask and partial covering
     * it are refused; a final verdict never moves again.
     */
    advance(paymentId: string, to: FakePaymentStatus, receivedCents?: number) {
      const p = payments.get(paymentId)
      if (!p) throw new Error(`fake Devolada: no payment ${paymentId}`)
      if (FINAL.has(p.status)) throw new Error(`fake Devolada: ${paymentId} already ended ${p.status}`)
      const at = now()
      p.awaiting = null
      p.awaitingReason = null
      if (to === 'confirmed' || to === 'partial' || to === 'unapplied') {
        const received = receivedCents ?? p.askedCents
        if (to === 'confirmed' && received < p.askedCents) throw new Error('fake Devolada: confirmed below the ask')
        if (to === 'partial' && received >= p.askedCents) throw new Error('fake Devolada: partial covers the ask')
        p.receivedCents = received
        p.match = received < p.askedCents ? 'short' : received > p.askedCents ? 'over' : 'exact'
        p.folio = `DV-${hex(3).toUpperCase()}`
        p.confirmedAt = at
        if (to === 'confirmed') links.get(p.linkId)!.paid = true
      } else if (FINAL.has(to)) {
        if (receivedCents !== undefined) throw new Error(`fake Devolada: receivedCents refused for ${to}`)
        p.confirmedAt = at
      }
      p.status = to
      return p
    },

    /** A validating payment that waits on the payer's clave de rastreo. */
    setAwaiting(
      paymentId: string,
      reason: 'all_used' | 'ambiguous' | 'no_match' | 'unreadable' = 'no_match',
    ) {
      const p = payments.get(paymentId)!
      p.status = 'validating'
      p.awaiting = 'payer_tracking_key'
      p.awaitingReason = reason
      return p
    },

    /** A `Request` for SELF.fetch: Devolada's webhook for this payment, validly signed. */
    async signedEvent(devoladaPaymentId: string, opts: SignedEventOptions = {}) {
      const p = payments.get(devoladaPaymentId)
      if (!p) throw new Error(`fake Devolada: no payment ${devoladaPaymentId}`)
      const status = opts.as ?? p.status
      const data = { paymentId: p.id, ...facts(p), ...(opts.isTest === undefined ? {} : { isTest: opts.isTest }) }
      const eventId = opts.eventId ?? `evt_${hex(16)}`
      const body = JSON.stringify({ eventId, type: `payment.${status}`, createdAt: now(), data })
      return fake.signedRaw(body, { ...opts, eventId })
    },

    /** A signed request carrying exactly `rawBody`, valid JSON or not. */
    async signedRaw(rawBody: string, opts: SignedEventOptions = {}) {
      const timestamp = String(now())
      const signer = opts.wrongKey ? pairs.other.privateKey : pairs.main.privateKey
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signer,
        enc.encode(`${timestamp}.${rawBody}`),
      )
      const sent = opts.tamperBody
        ? rawBody.replace(/"askedCents":(\d+)/, (_, n) => `"askedCents":${Number(n) + 1}`)
        : rawBody
      return new Request(WEBHOOK_REQUEST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Devolada-Event-Id': opts.eventId ?? `evt_${hex(16)}`,
          'Devolada-Timestamp': timestamp,
          'Devolada-Key-Id': opts.keyId ?? SIGNING_KEY_ID,
          'Devolada-Signature': `v1=${b64url(signature)}`,
        },
        body: sent,
      })
    },
  }
  return fake
}

export type FakeDevolada = Awaited<ReturnType<typeof installFakeDevolada>>
