import { Hono, type MiddlewareHandler } from 'hono'
import { ApiError } from '../../types/errors'
import { DevoladaUnavailableError, verifyDevoladaSignature } from '../../utils/devoladaSignature'
import { receiveDevoladaWebhook, type WebhooksEnv } from './handler'
import { devoladaWebhookEventSchema } from './schema'

// devolada-transfer-verification D4 — the public webhooks, one resource of their own (constitution
// IV). No session middleware: Devolada has no session, and proves itself with the signature. The one
// validation middleware runs the steps that come BEFORE the handler trusts anything:
//   1. refuse a body over 64 KiB, then read it raw;
//   2. verify the signature over the raw body — never over a parsed one;
//   3. parse and validate the event.
const MAX_BODY_BYTES = 64 * 1024

const verifiedDevoladaEvent: MiddlewareHandler<WebhooksEnv> = async (c, next) => {
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    throw new ApiError('WEBHOOK_PAYLOAD_INVALID', 400, 'The body exceeds 64 KiB')
  }
  const rawBody = await c.req.text()
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    throw new ApiError('WEBHOOK_PAYLOAD_INVALID', 400, 'The body exceeds 64 KiB')
  }

  let verified: boolean
  try {
    verified = await verifyDevoladaSignature(c.env, {
      timestamp: c.req.header('Devolada-Timestamp'),
      keyId: c.req.header('Devolada-Key-Id'),
      signatureHeader: c.req.header('Devolada-Signature'),
      rawBody,
    })
  } catch (err) {
    // Devolada retries after 1, 5, 15, 60 and 240 minutes.
    if (err instanceof DevoladaUnavailableError) {
      throw new ApiError('DEVOLADA_UNAVAILABLE', 503, "Devolada's signing keys are unavailable")
    }
    throw err
  }
  if (!verified) throw new ApiError('WEBHOOK_SIGNATURE_INVALID', 401, 'The signature does not verify')

  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    throw new ApiError('WEBHOOK_PAYLOAD_INVALID', 400, 'The body is not JSON')
  }
  const parsed = devoladaWebhookEventSchema.safeParse(json)
  if (!parsed.success) throw new ApiError('WEBHOOK_PAYLOAD_INVALID', 400, 'Not a Devolada event')
  c.set('devoladaEvent', parsed.data)
  return next()
}

const webhooks = new Hono<WebhooksEnv>()

webhooks.post('/devolada', verifiedDevoladaEvent, receiveDevoladaWebhook)

export default webhooks
