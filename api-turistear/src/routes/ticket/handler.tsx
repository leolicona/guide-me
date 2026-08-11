// US-T07 (docs/pos/express-sale.spec.md) — the public, line-scoped ticket page behind the QR.
//
// The QR now encodes `${API_BASE_URL}/t/<qr_token>` (D9), so a tourist's plain phone camera lands
// here while the agent's in-app scanner keeps redeeming the same code. This page is the DELIVERY
// surface of an Express counter sale — and a strictly minimal one (D10): the service, the
// departure, the pass count and the QR. Never the customer name, never the amount, never the
// Refund PIN — those live on the folio-scoped portal, whose token this page does not have.
//
// Two deliberate departures from its siblings, both written down in the spec:
//  - D12: there is no caller, so the org key derives from the PAYLOAD's organization_id (the
//    scanner derives from the scanning agent's org). Forgery still requires QR_SECRET.
//  - D11: strictly READ-ONLY — this page never touches redeemed_count. Only POST /api/tickets/scan
//    consumes a pass; a tourist checking their ticket on the bus must not burn their own seat.
import type { Context } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { renderSVG } from 'uqr'
import { getDb } from '../../db/client'
import { folios, folioLines, organizations, services } from '../../db/schema'
import { deriveOrgKey, peekTicketPayload, verifyTicket, type TicketPayload } from '../../utils/qr'
import { TicketCard, type TicketCardData } from './card'

export type TicketContext = Context<{
  Bindings: CloudflareBindings
  Variables: object
}>

// Same local-SVG rule as the portal (BUG-009): the token is the entry credential and must not
// leave our trust boundary via a third-party image service.
const qrSvg = (value: string): string => renderSVG(value, { ecc: 'M' })

// One generic failure page for unknown / tampered / expired tokens (rule 9) — no distinction
// leaks between "invalid" and "not ours".
const NotFoundPage = () => (
  <main class="portal">
    <div class="portal-card portal-error">
      <h1>Boleto no encontrado</h1>
      <p>
        No encontramos un boleto para este código. Verifica que escaneaste el código
        completo, o pide al vendedor que te lo reenvíe.
      </p>
      <p class="portal-muted">
        Si necesitas ayuda con tu compra, contacta directamente a la agencia donde la
        realizaste.
      </p>
    </div>
  </main>
)

const renderNotFound = (c: TicketContext) => {
  c.status(404)
  c.header('X-Robots-Tag', 'noindex')
  return c.render(<NotFoundPage />)
}

const TicketPage = ({
  orgName,
  line,
  qrMarkup,
  cancelled,
  token,
}: {
  orgName: string
  line: TicketCardData
  qrMarkup: string | null
  cancelled: boolean
  token: string
}) => (
  <main class="portal">
    <header class="portal-header">
      <p class="portal-org">{orgName}</p>
      <h1>Tu boleto</h1>
    </header>

    {cancelled ? (
      <section class="portal-card portal-cancelled">
        <h2>Este boleto fue cancelado</h2>
        <p>Los códigos de acceso ya no son válidos para ingresar.</p>
      </section>
    ) : (
      <TicketCard line={line} qrMarkup={qrMarkup} />
    )}

    <footer class="portal-footer">
      <p class="portal-muted">
        {orgName} — Boleto digital de Turistear Ya! Este código es personal; no lo compartas.
      </p>
    </footer>
    {/* Delivery beacon (rule 10, D13) — a real browser executing JS marks the ticket as both SENT
        and VIEWED: handing the QR across the counter IS the send, and a camera-scan is the
        strongest receipt signal we have. Link-preview crawlers fetch HTML but never run this. */}
    <script
      dangerouslySetInnerHTML={{
        __html: `addEventListener('DOMContentLoaded',function(){try{fetch('/t/'+${JSON.stringify(
          token,
        )}+'/seen',{method:'POST',keepalive:true}).catch(function(){})}catch(e){}})`,
      }}
    />
  </main>
)

// Resolve + VERIFY a token: peek the org id out of the payload (unverified, key selection only —
// D12), derive that org's key, verify the HMAC, then load the line it names. Any failure is the
// same generic null.
const resolveTicket = async (
  c: TicketContext,
): Promise<{ payload: TicketPayload; token: string } | null> => {
  const token = c.req.param('token')
  const peeked = peekTicketPayload(token)
  if (!peeked?.organization_id) return null
  const key = await deriveOrgKey(c.env.QR_SECRET, peeked.organization_id)
  const payload = await verifyTicket(token, key)
  if (!payload) return null
  return { payload, token }
}

// GET /t/:token — the ticket page (rule 9).
export const viewTicket = async (c: TicketContext) => {
  const resolved = await resolveTicket(c)
  if (!resolved) return renderNotFound(c)
  const { payload, token } = resolved

  // Expiry comes from the SIGNED payload — same clock the scanner enforces.
  if (payload.expires_at <= Math.floor(Date.now() / 1000)) return renderNotFound(c)

  const db = getDb(c.env)
  const rows = await db
    .select({
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      quantity: folioLines.quantity,
      zoneName: folioLines.zoneName,
      // US-A22 — the LINE's own cancellation: a cancelled line on a still-alive folio renders
      // the cancelled page, exactly like a cancelled folio.
      lineCancelledAt: folioLines.cancelledAt,
      folioStatus: folios.status,
      paymentVerification: folios.paymentVerification,
      description: services.description,
    })
    .from(folioLines)
    .innerJoin(folios, eq(folioLines.folioId, folios.id))
    .leftJoin(services, eq(folioLines.serviceId, services.id))
    .where(
      and(
        eq(folioLines.id, payload.folio_line_id),
        eq(folioLines.organizationId, payload.organization_id),
        eq(folioLines.folioId, payload.folio_id),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row || !row.slotDate || !row.slotStartTime) return renderNotFound(c)

  const orgRows = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, payload.organization_id))
    .limit(1)
  const orgName = orgRows[0]?.name ?? 'Turistear Ya!'

  // US-A22 (line-autonomy F2) — the line's own cancellation counts: a half-cancelled folio stays
  // `paid`, so without the line half this page would show a valid-looking pass for a line whose
  // seat went back to the pool.
  const cancelled = row.folioStatus === 'cancelled' || row.lineCancelledAt !== null
  // A folio that is not paid-and-cleared has no valid boarding pass to show (a booking's QR does
  // not exist until settle; an unverified transfer's is deferred) — generic page, no oracle.
  if (!cancelled && (row.folioStatus !== 'paid' || row.paymentVerification === 'pending')) {
    return renderNotFound(c)
  }

  const line: TicketCardData = {
    serviceName: row.serviceName,
    slotDate: row.slotDate,
    slotStartTime: row.slotStartTime,
    quantity: payload.passes_total,
    zoneName: row.zoneName,
    description: row.description,
  }

  c.header('X-Robots-Tag', 'noindex')
  return c.render(
    <TicketPage
      orgName={orgName}
      line={line}
      // D9 — the on-page QR carries the same URL form the counter showed, so a re-scan of a
      // saved screenshot resolves right back here. Omitted entirely on a cancelled folio.
      qrMarkup={cancelled ? null : qrSvg(`${c.env.API_BASE_URL}/t/${token}`)}
      cancelled={cancelled}
      token={token}
    />,
  )
}

// POST /t/:token/seen — the delivery beacon (rule 10). Sets BOTH tickets_sent_at and
// tickets_viewed_at if unset (first write wins; tickets_sent_by stays null — a counter handoff
// has no sending agent, express-sale Known behaviour 4). Always 204; a bad token is a silent
// no-op — nothing to acknowledge, nothing to leak.
export const markTicketSeen = async (c: TicketContext) => {
  const resolved = await resolveTicket(c)
  if (!resolved) return c.body(null, 204)
  const { payload } = resolved

  const db = getDb(c.env)
  const now = new Date()
  const scope = (extra: ReturnType<typeof isNull>) =>
    and(
      eq(folios.id, payload.folio_id),
      eq(folios.organizationId, payload.organization_id),
      extra,
    )
  c.executionCtx.waitUntil(
    db
      .batch([
        db
          .update(folios)
          .set({ ticketsViewedAt: now })
          .where(scope(isNull(folios.ticketsViewedAt))),
        db
          .update(folios)
          .set({ ticketsSentAt: now })
          .where(scope(isNull(folios.ticketsSentAt))),
      ])
      .then(() => undefined)
      .catch(() => undefined),
  )
  return c.body(null, 204)
}
