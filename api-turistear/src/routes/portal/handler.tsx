import type { Context } from 'hono'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { renderSVG } from 'uqr'
import { TicketCard, formatSlotDate } from '../ticket/card'
import { getDb, type Db } from '../../db/client'
import {
  folioRequests,
  folioAccessTokens,
  folioLines,
  folios,
  organizations,
  services,
} from '../../db/schema'
import { folioEventRow } from '../../utils/folioEvents'

// Tourist self-service portal (US-T01–T05) — PUBLIC Worker-rendered pages (spec D1).
// No session, no role: the folio-scoped access token in the URL IS the credential (D2).
// Every byte rendered here is for exactly one folio, resolved server-side BEFORE rendering.
// Spec: docs/tourist-portal/tourist-self-service-portal.spec.md

export type PortalContext = Context<{
  Bindings: CloudflareBindings
  Variables: object
}>

const REASON_MAX_LENGTH = 500

// QR rendered locally as inline SVG (BUG-009): the signed token IS the entry credential,
// so it must never leave our trust boundary the way the old api.qrserver.com <img> URL
// did. (The confirmation email still uses the external service — <img> is the only thing
// mail clients render and they refuse data: URIs; tracked as the BUG-009 residual.)
const qrSvg = (token: string): string => renderSVG(token, { ecc: 'M' })

const shortId = (id: string): string => id.slice(0, 8).toUpperCase()

const formatAmount = (cents: number): string =>
  `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`

// formatSlotDate moved to ../ticket/card with the shared TicketCard (US-T07 extraction).

// --- Token resolution (Rule 2) -------------------------------------------------

type TokenResolution =
  | { kind: 'ok'; folioId: string; organizationId: string; tokenId: string }
  | { kind: 'not_found' }
  | { kind: 'expired' }

const resolveToken = async (db: Db, token: string): Promise<TokenResolution> => {
  const [row] = await db
    .select({
      id: folioAccessTokens.id,
      folioId: folioAccessTokens.folioId,
      organizationId: folioAccessTokens.organizationId,
      expiresAt: folioAccessTokens.expiresAt,
    })
    .from(folioAccessTokens)
    .where(eq(folioAccessTokens.token, token))
    .limit(1)

  if (!row) return { kind: 'not_found' }
  if (row.expiresAt.getTime() <= Date.now()) return { kind: 'expired' }
  return {
    kind: 'ok',
    folioId: row.folioId,
    organizationId: row.organizationId,
    tokenId: row.id,
  }
}

// --- Error pages (generic copy — no folio enumeration, Rule 2) -------------------

const ErrorPage = ({ title, body }: { title: string; body: string }) => (
  <main class="portal">
    <div class="portal-card portal-error">
      <h1>{title}</h1>
      <p>{body}</p>
      <p class="portal-muted">
        Si necesitas ayuda con tu reserva, contacta directamente a la agencia donde
        realizaste tu compra.
      </p>
    </div>
  </main>
)

const renderNotFound = (c: PortalContext) => {
  c.status(404)
  c.header('X-Robots-Tag', 'noindex')
  return c.render(
    <ErrorPage
      title="Enlace no válido"
      body="No encontramos una reserva para este enlace. Verifica que abriste el enlace completo de tu correo de confirmación."
    />,
  )
}

const renderExpired = (c: PortalContext) => {
  c.status(410)
  c.header('X-Robots-Tag', 'noindex')
  return c.render(
    <ErrorPage
      title="Enlace expirado"
      body="Este enlace ya no está activo. Los enlaces del portal expiran un tiempo después de la fecha de tu último servicio."
    />,
  )
}

// --- The portal page (US-T02/T03/T04/T05) ----------------------------------------

interface PortalLine {
  serviceName: string
  slotDate: string
  slotStartTime: string
  quantity: number
  qrToken: string | null
  // US-A64 — the physical zone (Turibus deck) this line's seats are in, snapshotted at sale.
  zoneName: string | null
  // The service's CURRENT description (meeting point / instructions) — live, not a sale
  // snapshot, so an updated meeting point reaches the tourist (Rule 3 / open question 1).
  description: string | null
  // US-A22 (line-autonomy F2) — the line's own life: a cancelled line on a still-active folio
  // loses its QR here and states its refund outcome, exactly like a cancelled folio would.
  cancelledAt: Date | null
  refundStatus: 'none' | 'pending' | 'refunded'
  refundAmount: number | null
}

interface PortalData {
  token: string
  orgName: string
  // For the QR's URL form (express-sale D9): the on-page QR encodes `${apiBaseUrl}/t/<token>`.
  apiBaseUrl: string
  folio: {
    id: string
    status: 'paid' | 'booking' | 'cancelled'
    total: number
    amountPaid: number
    refundStatus: 'none' | 'pending' | 'refunded'
    refundAmount: number | null
    refundPin: string | null
  }
  lines: PortalLine[]
  request: { status: 'pending' | 'approved' | 'rejected'; resolutionNote: string | null } | null
}

// US-A22 (line-autonomy F2) — the refund block, shared by both shapes of cancellation: the whole
// folio, or some of its lines while the rest live on. The PIN is ONE per folio (D6 — it proves
// the person, not the amount); the per-line outcomes spell out where every peso went, because
// "pagué X y me devuelven Y" is answered nowhere else the tourist can reach.
const RefundBlock = ({ folio, lines }: { folio: PortalData['folio']; lines: PortalLine[] }) => {
  const owed = lines.filter((l) => l.refundStatus === 'pending' && (l.refundAmount ?? 0) > 0)
  if (folio.refundStatus === 'pending' && folio.refundPin) {
    return (
      <div class="portal-pin">
        <h3>Tu PIN de reembolso</h3>
        <p class="portal-pin-code">{folio.refundPin}</p>
        {owed.length > 0 && (
          <ul class="portal-muted">
            {owed.map((l) => (
              <li>
                {l.serviceName} ({formatSlotDate(l.slotDate)}):{' '}
                {formatAmount(l.refundAmount ?? 0)}
              </li>
            ))}
          </ul>
        )}
        <p>
          Da este código al agente o administrador para recibir tu reembolso
          {folio.refundAmount != null ? ` de ${formatAmount(folio.refundAmount)}` : ''} en
          efectivo. Es tu comprobante de que recibiste el dinero — no lo compartas antes.
        </p>
      </div>
    )
  }
  if (folio.refundStatus === 'refunded') {
    return <p class="portal-refunded">✓ Reembolso confirmado. ¡Gracias!</p>
  }
  return null
}

const CancellationBlock = ({ data }: { data: PortalData }) => {
  const { folio, request, token } = data

  // US-A22 — some lines cancelled, the folio still alive: state it, with the refund block when
  // money is owed. The request form below stays reachable for the surviving activities.
  const cancelledLines = data.lines.filter((l) => l.cancelledAt !== null)
  const partialBlock =
    folio.status !== 'cancelled' && cancelledLines.length > 0 ? (
      <section class="portal-card portal-cancelled">
        <h2>
          {cancelledLines.length === 1
            ? 'Una actividad fue cancelada'
            : 'Algunas actividades fueron canceladas'}
        </h2>
        <p>El resto de tu reserva sigue activa; sus códigos siguen siendo válidos.</p>
        <RefundBlock folio={folio} lines={data.lines} />
      </section>
    ) : null

  if (folio.status === 'cancelled') {
    return (
      <section class="portal-card portal-cancelled">
        <h2>Reserva cancelada</h2>
        <p>
          Esta reserva fue cancelada. Los códigos de acceso ya no son válidos para
          ingresar.
        </p>
        <RefundBlock folio={folio} lines={data.lines} />
      </section>
    )
  }

  if (request?.status === 'pending') {
    return (
      <>
        {partialBlock}
        <section class="portal-card">
          <h2>Solicitud de cancelación en revisión</h2>
          <p>
            La agencia está revisando tu solicitud. Te notificará el resultado; tu
            reserva sigue activa mientras tanto.
          </p>
        </section>
      </>
    )
  }

  return (
    <>
      {partialBlock}
      <section class="portal-card">
      {request?.status === 'rejected' && (
        <p class="portal-rejected">
          Tu solicitud anterior fue rechazada
          {request.resolutionNote ? `: “${request.resolutionNote}”` : '.'}
        </p>
      )}
      <details>
        <summary>¿Necesitas cancelar tu reserva?</summary>
        <form method="post" action={`/portal/${token}/cancellation-request`}>
          <label for="reason">Motivo (opcional)</label>
          <textarea
            id="reason"
            name="reason"
            rows={3}
            maxlength={REASON_MAX_LENGTH}
            placeholder="Cuéntanos por qué deseas cancelar"
          ></textarea>
          <button type="submit">Solicitar cancelación</button>
          <p class="portal-muted">
            La agencia revisará tu solicitud — tu reserva sigue activa hasta que sea
            aprobada.
          </p>
        </form>
      </details>
      </section>
    </>
  )
}

const PortalPage = ({ data }: { data: PortalData }) => {
  const cancelled = data.folio.status === 'cancelled'
  return (
    <main class="portal">
      <header class="portal-header">
        <p class="portal-org">{data.orgName}</p>
        <h1>Tu reserva</h1>
        <p class="portal-muted">
          Folio #{shortId(data.folio.id)} · Total {formatAmount(data.folio.total)}
        </p>
      </header>

      {cancelled && <p class="portal-banner">Reserva cancelada</p>}

      <section>
        <h2 class="portal-section-title">Itinerario</h2>
        {/* US-T03 — the boarding-pass card, shared with the /t/:token ticket page (US-T07) so the
            two surfaces cannot drift. The QR is omitted entirely on a cancelled folio so the page
            never implies a valid ticket (Rule 3); since express-sale D9 it encodes the /t/<token>
            URL, so a plain camera resolves to the ticket page while the scanner still redeems. */}
        {data.lines.map((line) => (
          <TicketCard
            line={{ ...line, cancelled: line.cancelledAt !== null }}
            qrMarkup={
              // US-A22 — a cancelled LINE loses its QR even while its siblings' remain valid.
              !cancelled && !line.cancelledAt && line.qrToken
                ? qrSvg(`${data.apiBaseUrl}/t/${line.qrToken}`)
                : null
            }
          />
        ))}
      </section>

      <CancellationBlock data={data} />

      <footer class="portal-footer">
        <p class="portal-muted">
          {data.orgName} — Gestión de reservas con Turistear Ya! Este enlace es personal; no
          lo compartas.
        </p>
      </footer>
      {/* "Visto" beacon (whatsapp-qr-delivery D6): fired from client JS AFTER render, so
          link-preview crawlers (facebookexternalhit et al.) — which fetch the HTML but never
          execute JS — can't forge a delivery confirmation. One-shot; failures are swallowed. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `addEventListener('DOMContentLoaded',function(){try{fetch('/portal/'+${JSON.stringify(
            data.token,
          )}+'/seen',{method:'POST',keepalive:true}).catch(function(){})}catch(e){}})`,
        }}
      />
    </main>
  )
}

// --- Handlers --------------------------------------------------------------------

const loadPortalData = async (
  db: Db,
  org: string,
  folioId: string,
  token: string,
): Promise<PortalData | null> => {
  const [folio] = await db
    .select({
      id: folios.id,
      status: folios.status,
      total: folios.total,
      amountPaid: folios.amountPaid,
      refundStatus: folios.refundStatus,
      refundAmount: folios.refundAmount,
      refundPin: folios.refundPin,
      orgName: organizations.name,
    })
    .from(folios)
    .innerJoin(organizations, eq(folios.organizationId, organizations.id))
    .where(and(eq(folios.id, folioId), eq(folios.organizationId, org)))
    .limit(1)
  if (!folio) return null

  const lines = await db
    .select({
      serviceName: folioLines.serviceName,
      slotDate: folioLines.slotDate,
      slotStartTime: folioLines.slotStartTime,
      quantity: folioLines.quantity,
      qrToken: folioLines.qrToken,
      zoneName: folioLines.zoneName,
      description: services.description,
      // US-A22 — the line's own cancellation + refund outcome.
      cancelledAt: folioLines.cancelledAt,
      refundStatus: folioLines.refundStatus,
      refundAmount: folioLines.refundAmount,
    })
    .from(folioLines)
    .innerJoin(services, eq(folioLines.serviceId, services.id))
    .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))
    .orderBy(folioLines.slotDate, folioLines.slotStartTime)

  const [request] = await db
    .select({
      status: folioRequests.status,
      resolutionNote: folioRequests.resolutionNote,
    })
    .from(folioRequests)
    .where(
      and(
        eq(folioRequests.folioId, folioId),
        eq(folioRequests.organizationId, org),
      ),
    )
    .orderBy(desc(folioRequests.createdAt))
    .limit(1)

  return {
    token,
    orgName: folio.orgName,
    apiBaseUrl: '', // overwritten by the caller from c.env (loadPortalData has no env access)
    folio: {
      id: folio.id,
      status: folio.status,
      total: folio.total,
      amountPaid: folio.amountPaid,
      refundStatus: folio.refundStatus,
      refundAmount: folio.refundAmount,
      refundPin: folio.refundPin,
    },
    lines,
    request: request ?? null,
  }
}

// US-T02/T03/T05 — GET /portal/:token. Unknown → 404 page, expired → 410 page (generic
// copy, Rule 2); otherwise render the folio's itinerary + QRs + cancellation/refund state
// and touch last_accessed_at.
export const viewPortal = async (c: PortalContext) => {
  const db = getDb(c.env)
  const resolution = await resolveToken(db, c.req.param('token'))
  if (resolution.kind === 'not_found') return renderNotFound(c)
  if (resolution.kind === 'expired') return renderExpired(c)

  const data = await loadPortalData(
    db,
    resolution.organizationId,
    resolution.folioId,
    c.req.param('token'),
  )
  if (!data) return renderNotFound(c)
  // express-sale D9 — the page QRs encode the /t/<token> URL form.
  data.apiBaseUrl = c.env.API_BASE_URL

  c.executionCtx.waitUntil(
    db
      .update(folioAccessTokens)
      .set({ lastAccessedAt: new Date() })
      .where(eq(folioAccessTokens.id, resolution.tokenId))
      .then(() => undefined)
      .catch(() => undefined),
  )

  c.header('X-Robots-Tag', 'noindex')
  return c.render(<PortalPage data={data} />)
}

// POST /portal/:token/seen — the bot-proof "Visto" beacon (whatsapp-qr-delivery D6). The portal
// page calls this from client JS after render, so link-preview crawlers (which fetch HTML but never
// run JS) can't forge it. Idempotent first-view: stamps the folio's tickets_viewed_at once. Always
// 204 — a bad/expired token is a silent no-op (nothing to acknowledge, nothing to leak).
export const markPortalSeen = async (c: PortalContext) => {
  const db = getDb(c.env)
  const resolution = await resolveToken(db, c.req.param('token'))
  if (resolution.kind !== 'ok') return c.body(null, 204)

  const now = new Date()
  c.executionCtx.waitUntil(
    db
      .update(folios)
      .set({ ticketsViewedAt: now })
      .where(
        and(
          eq(folios.id, resolution.folioId),
          eq(folios.organizationId, resolution.organizationId),
          isNull(folios.ticketsViewedAt), // first view wins the timestamp
        ),
      )
      .returning({ id: folios.id })
      // US-A24 — the narrative row, first view ONLY: a repeat open matches 0 rows and narrates
      // nothing. The actor is the tourist, so actor_id stays NULL (renders "Cliente").
      .then((won) =>
        won.length > 0
          ? folioEventRow(db, {
              organizationId: resolution.organizationId,
              folioId: resolution.folioId,
              type: 'tickets_viewed',
              at: now,
            }).then(() => undefined)
          : undefined,
      )
      .catch(() => undefined),
  )
  return c.body(null, 204)
}

// US-T04 — POST /portal/:token/cancellation-request (classic form post, no client JS).
// Creates a `pending` request — NEVER touches inventory or folio status (spec D4); only an
// admin approval funnels into cancelFolio. 409 on a cancelled folio or a duplicate open
// request (the partial unique index is the race backstop). 303 → back to the portal page.
export const submitCancellationRequest = async (c: PortalContext) => {
  const db = getDb(c.env)
  const token = c.req.param('token')
  const resolution = await resolveToken(db, token)
  if (resolution.kind === 'not_found') return renderNotFound(c)
  if (resolution.kind === 'expired') return renderExpired(c)

  const [folio] = await db
    .select({ status: folios.status })
    .from(folios)
    .where(
      and(
        eq(folios.id, resolution.folioId),
        eq(folios.organizationId, resolution.organizationId),
      ),
    )
    .limit(1)
  if (!folio) return renderNotFound(c)

  const conflict = (body: string) => {
    c.status(409)
    c.header('X-Robots-Tag', 'noindex')
    return c.render(
      <main class="portal">
        <div class="portal-card portal-error">
          <h1>No se pudo enviar la solicitud</h1>
          <p>{body}</p>
          <p>
            <a href={`/portal/${token}`}>Volver a mi reserva</a>
          </p>
        </div>
      </main>,
    )
  }

  if (folio.status === 'cancelled') {
    return conflict('Esta reserva ya fue cancelada.')
  }

  const [open] = await db
    .select({ id: folioRequests.id })
    .from(folioRequests)
    .where(
      and(
        eq(folioRequests.folioId, resolution.folioId),
        eq(folioRequests.organizationId, resolution.organizationId),
        eq(folioRequests.status, 'pending'),
      ),
    )
    .limit(1)
  if (open) {
    return conflict('Ya hay una solicitud en revisión para esta reserva.')
  }

  const body = await c.req.parseBody()
  const rawReason = typeof body.reason === 'string' ? body.reason.trim() : ''
  const reason = rawReason ? rawReason.slice(0, REASON_MAX_LENGTH) : null

  try {
    await db.insert(folioRequests).values({
      id: crypto.randomUUID(),
      organizationId: resolution.organizationId,
      folioId: resolution.folioId,
      status: 'pending',
      reason,
    })
  } catch {
    // Unique-index race: another open request landed between the check and the insert.
    return conflict('Ya hay una solicitud en revisión para esta reserva.')
  }

  return c.redirect(`/portal/${token}`, 303)
}


// US-AG52 (D2) — the TOURIST origin. The other one is the counter, where the seller acts with the
// customer in front of them; this is the same agreement reached from the customer's side.
//
// Almost nothing here is new, and that is the point: `resolveToken` is the same authorization the
// ticket link already uses, `folio_requests` is the same table, and the one-open-petition guard
// below is the SAME query the cancellation request runs — since the index was widened to cover both
// kinds, it now stops a folio carrying a pending cancellation AND a pending reschedule without a
// line of new code.
//
// It reserves NOTHING. Seats cannot be held for a petition nobody has approved, so the capacity
// check happens at approval — which is why a request can be refused later, and why the refusal
// carries alternatives.
export const submitRescheduleRequest = async (c: PortalContext) => {
  const db = getDb(c.env)
  const token = c.req.param('token')
  const resolution = await resolveToken(db, token)
  if (resolution.kind === 'not_found') return renderNotFound(c)
  if (resolution.kind === 'expired') return renderExpired(c)

  const conflict = (body: string) => {
    c.status(409)
    c.header('X-Robots-Tag', 'noindex')
    return c.render(
      <main class="portal">
        <div class="portal-card portal-error">
          <h1>No se pudo enviar la solicitud</h1>
          <p>{body}</p>
          <p>
            <a href={`/portal/${token}`}>Volver a mi reserva</a>
          </p>
        </div>
      </main>,
    )
  }

  const [folio] = await db
    .select({ status: folios.status })
    .from(folios)
    .where(
      and(
        eq(folios.id, resolution.folioId),
        eq(folios.organizationId, resolution.organizationId),
      ),
    )
    .limit(1)
  if (!folio) return renderNotFound(c)
  if (folio.status === 'cancelled') {
    return conflict('Esta reserva ya fue cancelada.')
  }

  const [open] = await db
    .select({ id: folioRequests.id })
    .from(folioRequests)
    .where(
      and(
        eq(folioRequests.folioId, resolution.folioId),
        eq(folioRequests.organizationId, resolution.organizationId),
        eq(folioRequests.status, 'pending'),
      ),
    )
    .limit(1)
  if (open) {
    return conflict('Ya hay una solicitud en revisión para esta reserva.')
  }

  const body = await c.req.parseBody()
  const lineId = typeof body.folio_line_id === 'string' ? body.folio_line_id : ''
  const toSlotId = typeof body.to_slot_id === 'string' ? body.to_slot_id : ''
  if (!lineId || !toSlotId) {
    return conflict('Elige el servicio y el nuevo horario.')
  }

  // The line must belong to THIS folio. A token grants access to one folio, and a body is not
  // allowed to widen that.
  const [line] = await db
    .select({ id: folioLines.id, slotId: folioLines.slotId })
    .from(folioLines)
    .where(
      and(
        eq(folioLines.id, lineId),
        eq(folioLines.folioId, resolution.folioId),
        eq(folioLines.organizationId, resolution.organizationId),
      ),
    )
    .limit(1)
  if (!line) return conflict('Ese servicio no pertenece a tu reserva.')

  try {
    await db.insert(folioRequests).values({
      id: crypto.randomUUID(),
      organizationId: resolution.organizationId,
      folioId: resolution.folioId,
      kind: 'reschedule',
      status: 'pending',
      folioLineId: line.id,
      fromSlotId: line.slotId,
      toSlotId,
    })
  } catch {
    return conflict('Ya hay una solicitud en revisión para esta reserva.')
  }

  return c.redirect(`/portal/${token}`, 303)
}
