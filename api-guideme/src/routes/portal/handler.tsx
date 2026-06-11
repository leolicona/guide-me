import type { Context } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { getDb, type Db } from '../../db/client'
import {
  cancellationRequests,
  folioAccessTokens,
  folioLines,
  folios,
  organizations,
  services,
} from '../../db/schema'

// Tourist self-service portal (US-T01–T05) — PUBLIC Worker-rendered pages (spec D1).
// No session, no role: the folio-scoped access token in the URL IS the credential (D2).
// Every byte rendered here is for exactly one folio, resolved server-side BEFORE rendering.
// Spec: docs/tourist-portal/tourist-self-service-portal.spec.md

export type PortalContext = Context<{
  Bindings: CloudflareBindings
  Variables: object
}>

const REASON_MAX_LENGTH = 500

// Same external QR-image service the confirmation email uses (client-ticket-delivery spec).
const qrImageUrl = (token: string): string =>
  `https://api.qrserver.com/v1/create-qr-code/?size=250x250&ecc=M&data=${encodeURIComponent(token)}`

const shortId = (id: string): string => id.slice(0, 8).toUpperCase()

const formatAmount = (cents: number): string =>
  `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`

const formatSlotDate = (slotDate: string): string => {
  const parsed = Date.parse(`${slotDate}T12:00:00Z`)
  if (!Number.isFinite(parsed)) return slotDate
  return new Date(parsed).toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

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
  // The service's CURRENT description (meeting point / instructions) — live, not a sale
  // snapshot, so an updated meeting point reaches the tourist (Rule 3 / open question 1).
  description: string | null
}

interface PortalData {
  token: string
  orgName: string
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

const CancellationBlock = ({ data }: { data: PortalData }) => {
  const { folio, request, token } = data

  if (folio.status === 'cancelled') {
    return (
      <section class="portal-card portal-cancelled">
        <h2>Reserva cancelada</h2>
        <p>
          Esta reserva fue cancelada. Los códigos de acceso ya no son válidos para
          ingresar.
        </p>
        {folio.refundStatus === 'pending' && folio.refundPin && (
          <div class="portal-pin">
            <h3>Tu PIN de reembolso</h3>
            <p class="portal-pin-code">{folio.refundPin}</p>
            <p>
              Da este código al agente o administrador para recibir tu reembolso
              {folio.refundAmount != null
                ? ` de ${formatAmount(folio.refundAmount)}`
                : ''}{' '}
              en efectivo. Es tu comprobante de que recibiste el dinero — no lo
              compartas antes.
            </p>
          </div>
        )}
        {folio.refundStatus === 'refunded' && (
          <p class="portal-refunded">✓ Reembolso confirmado. ¡Gracias!</p>
        )}
      </section>
    )
  }

  if (request?.status === 'pending') {
    return (
      <section class="portal-card">
        <h2>Solicitud de cancelación en revisión</h2>
        <p>
          La agencia está revisando tu solicitud. Te notificará el resultado; tu
          reserva sigue activa mientras tanto.
        </p>
      </section>
    )
  }

  return (
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
        {data.lines.map((line) => (
          <article class="portal-card portal-line">
            <h3>{line.serviceName}</h3>
            <p>
              📅 {formatSlotDate(line.slotDate)} — {line.slotStartTime} h
            </p>
            <p>👥 {line.quantity} {line.quantity === 1 ? 'persona' : 'personas'}</p>
            {line.description && <p class="portal-muted">{line.description}</p>}
            {/* US-T03 — the same signed QR the email carries. Omitted entirely on a
                cancelled folio so the page never implies a valid ticket (Rule 3). */}
            {!cancelled && line.qrToken && (
              <div class="portal-qr">
                <img
                  src={qrImageUrl(line.qrToken)}
                  alt={`Código QR — ${line.serviceName}`}
                  width="220"
                  height="220"
                />
                <p class="portal-muted">Presenta este código al llegar</p>
              </div>
            )}
          </article>
        ))}
      </section>

      <CancellationBlock data={data} />

      <footer class="portal-footer">
        <p class="portal-muted">
          {data.orgName} — Gestión de reservas con GuideMe. Este enlace es personal; no
          lo compartas.
        </p>
      </footer>
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
      description: services.description,
    })
    .from(folioLines)
    .innerJoin(services, eq(folioLines.serviceId, services.id))
    .where(and(eq(folioLines.folioId, folioId), eq(folioLines.organizationId, org)))
    .orderBy(folioLines.slotDate, folioLines.slotStartTime)

  const [request] = await db
    .select({
      status: cancellationRequests.status,
      resolutionNote: cancellationRequests.resolutionNote,
    })
    .from(cancellationRequests)
    .where(
      and(
        eq(cancellationRequests.folioId, folioId),
        eq(cancellationRequests.organizationId, org),
      ),
    )
    .orderBy(desc(cancellationRequests.createdAt))
    .limit(1)

  return {
    token,
    orgName: folio.orgName,
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
    .select({ id: cancellationRequests.id })
    .from(cancellationRequests)
    .where(
      and(
        eq(cancellationRequests.folioId, resolution.folioId),
        eq(cancellationRequests.organizationId, resolution.organizationId),
        eq(cancellationRequests.status, 'pending'),
      ),
    )
    .limit(1)
  if (open) {
    return conflict('Ya hay una solicitud de cancelación en revisión para esta reserva.')
  }

  const body = await c.req.parseBody()
  const rawReason = typeof body.reason === 'string' ? body.reason.trim() : ''
  const reason = rawReason ? rawReason.slice(0, REASON_MAX_LENGTH) : null

  try {
    await db.insert(cancellationRequests).values({
      id: crypto.randomUUID(),
      organizationId: resolution.organizationId,
      folioId: resolution.folioId,
      status: 'pending',
      reason,
    })
  } catch {
    // Unique-index race: another open request landed between the check and the insert.
    return conflict('Ya hay una solicitud de cancelación en revisión para esta reserva.')
  }

  return c.redirect(`/portal/${token}`, 303)
}
