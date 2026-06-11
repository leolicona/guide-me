import { Hono } from 'hono'
import { submitCancellationRequest, viewPortal } from './handler'

// Tourist self-service portal (US-T01–T05) — PUBLIC routes: no authMiddleware, no role.
// The folio-scoped access token in the path IS the credential (spec D2); it resolves to
// exactly one folio server-side before anything renders. Mounted OUTSIDE /api/* (no CORS
// involvement) and AFTER the jsxRenderer so c.render is available.
const portal = new Hono<{ Bindings: CloudflareBindings }>()

portal.get('/:token', viewPortal)
portal.post('/:token/cancellation-request', submitCancellationRequest)

export default portal
