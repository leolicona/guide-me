// The one boarding-pass card, shared by the tourist PORTAL (folio-scoped, all lines) and the
// public TICKET page /t/:token (line-scoped, US-T07). Extracted from PortalPage's line map so the
// two surfaces cannot drift — same markup, same `.portal-*` classes (src/style.css).
//
// Deliberately dumb: the OWNER decides what qrMarkup to pass (null on a cancelled folio — the
// card must never imply a valid ticket, portal Rule 3) and what data reaches it. The ticket page
// passes exactly one line and NOTHING else — no name, no amount, no Refund PIN (express-sale D10).

export const formatSlotDate = (slotDate: string): string => {
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

export interface TicketCardData {
  serviceName: string
  slotDate: string
  slotStartTime: string
  quantity: number
  // US-A64 — the physical zone (Turibus deck); null for an unzoned line.
  zoneName: string | null
  // The service's CURRENT description (meeting point / instructions) — live, not a snapshot.
  description: string | null
}

export const TicketCard = ({
  line,
  qrMarkup,
}: {
  line: TicketCardData
  qrMarkup: string | null
}) => (
  <article class="portal-card portal-line">
    <h3>{line.serviceName}</h3>
    <p>
      📅 {formatSlotDate(line.slotDate)} — {line.slotStartTime} h
    </p>
    {line.zoneName && <p>📍 {line.zoneName}</p>}
    <p>
      👥 {line.quantity} {line.quantity === 1 ? 'persona' : 'personas'}
    </p>
    {line.description && <p class="portal-muted">{line.description}</p>}
    {qrMarkup && (
      <div class="portal-qr">
        <div
          role="img"
          aria-label={`Código QR — ${line.serviceName}`}
          style="width:220px;height:220px"
          dangerouslySetInnerHTML={{ __html: qrMarkup }}
        />
        <p class="portal-muted">Presenta este código al llegar</p>
      </div>
    )}
  </article>
)
