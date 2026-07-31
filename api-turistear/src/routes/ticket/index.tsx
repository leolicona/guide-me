import { Hono } from 'hono'
import { markTicketSeen, viewTicket } from './handler'

// US-T07 — the public ticket page behind the QR (docs/pos/express-sale.spec.md). PUBLIC like the
// portal: no authMiddleware, no role — the signed qr_token in the path IS the credential (verified
// under the payload org's derived key, D12). Mounted OUTSIDE /api/* (no CORS involvement) and
// AFTER the jsxRenderer so c.render is available. Read-only: nothing here can redeem a pass (D11).
const ticket = new Hono<{ Bindings: CloudflareBindings }>()

ticket.get('/:token', viewTicket)
// The delivery beacon (rule 10) — client-JS only, bot-proof; sets sent+viewed. Always 204.
ticket.post('/:token/seen', markTicketSeen)

export default ticket
