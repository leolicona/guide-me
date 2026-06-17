import { ApiError } from '../types/errors'

// --- Minor-unit amounts → "MXN 1,250.00" display string ---
const formatAmount = (cents: number): string =>
  `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`

// --- QR code image URL (external PNG service; no library needed) ---
const qrImageUrl = (token: string): string =>
  `https://api.qrserver.com/v1/create-qr-code/?size=250x250&ecc=M&data=${encodeURIComponent(token)}`

// A short folio reference for display: first 8 chars of the UUID.
const shortId = (id: string): string => id.slice(0, 8).toUpperCase()

// --- Escape user-controlled text before HTML interpolation (spec Business Rule 9) ---
// customer_name / cancellation_reason are free-text from POS; service_name / org_name
// are snapshots. Prevents broken rendering and injected markup (in-email phishing).
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  )

interface MagicLinkEmailInput {
  to: string
  name: string
  magicLink: string
}

export const sendMagicLinkEmail = async (
  env: CloudflareBindings,
  { to, name, magicLink }: MagicLinkEmailInput,
): Promise<void> => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to,
      subject: 'Verifica tu cuenta de GuideMe',
      html: `
        <p>Hola ${name},</p>
        <p>Gracias por registrarte en GuideMe. Verifica tu cuenta haciendo clic en el siguiente enlace (válido por 10 minutos):</p>
        <p><a href="${magicLink}">Verificar mi cuenta</a></p>
        <p>Si tú no creaste esta cuenta, puedes ignorar este correo.</p>
      `,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new ApiError('INTERNAL_ERROR', 502, `Resend error: ${body}`)
  }
}

interface InvitationEmailInput {
  to: string
  organizationName: string
  inviteLink: string
}

export const sendInvitationEmail = async (
  env: CloudflareBindings,
  { to, organizationName, inviteLink }: InvitationEmailInput,
): Promise<void> => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to,
      subject: `Invitación para unirte a ${organizationName} en GuideMe`,
      html: `
        <p>Hola,</p>
        <p>Has sido invitado a unirte a <strong>${organizationName}</strong> como agente en GuideMe.</p>
        <p>Completa tu registro haciendo clic en el siguiente enlace (válido por 7 días):</p>
        <p><a href="${inviteLink}">Aceptar invitación</a></p>
        <p>Si tú no esperabas esta invitación, puedes ignorar este correo.</p>
      `,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new ApiError('INTERNAL_ERROR', 502, `Resend error: ${body}`)
  }
}

interface PasswordResetEmailInput {
  to: string
  name: string
  resetLink: string
}

export const sendPasswordResetEmail = async (
  env: CloudflareBindings,
  { to, name, resetLink }: PasswordResetEmailInput,
): Promise<void> => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to,
      subject: 'Recupera tu contraseña de GuideMe',
      html: `
        <p>Hola ${name},</p>
        <p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el siguiente enlace (válido por 1 hora):</p>
        <p><a href="${resetLink}">Restablecer mi contraseña</a></p>
        <p>Si tú no solicitaste este cambio, puedes ignorar este correo. Tu contraseña actual seguirá siendo válida.</p>
      `,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new ApiError('INTERNAL_ERROR', 502, `Resend error: ${body}`)
  }
}

export interface TicketConfirmationEmailInput {
  to: string
  customerName: string | null
  orgName: string
  folioId: string
  createdAt: Date
  paymentMethod: 'cash' | 'card' | 'transfer' | 'link'
  total: number
  // US-T01 — Magic Link into the tourist self-service portal (itinerary, QR, cancellation
  // request). Absent when token issuance failed (best-effort; never blocks the sale).
  portalLink?: string
  lines: Array<{
    serviceName: string
    slotDate: string        // 'YYYY-MM-DD'
    slotStartTime: string   // 'HH:MM'
    quantity: number
    unitPrice: number
    lineTotal: number
    qrToken: string
    extras: Array<{ name: string; price: number; quantity: number }>
  }>
}

export const sendTicketConfirmationEmail = async (
  env: CloudflareBindings,
  data: TicketConfirmationEmailInput,
): Promise<void> => {
  // Build one <section> per service line, each with a QR code image.
  const linesHtml = data.lines.map((line) => {
    const extrasHtml =
      line.extras.length > 0
        ? `<ul>${line.extras
            .map(
              (ex) =>
                `<li>+ ${escapeHtml(ex.name)} (×${ex.quantity}): ${formatAmount(ex.price * ex.quantity)}</li>`,
            )
            .join('')}</ul>`
        : ''

    const serviceName = escapeHtml(line.serviceName)
    return `
      <div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin:16px 0;">
        <h3 style="margin:0 0 8px">${serviceName}</h3>
        <p style="margin:4px 0">📅 <strong>${line.slotDate}</strong> — ${line.slotStartTime}</p>
        <p style="margin:4px 0">👥 Personas: ${line.quantity}</p>
        <p style="margin:4px 0">💰 ${formatAmount(line.unitPrice)} × ${line.quantity} = <strong>${formatAmount(line.lineTotal)}</strong></p>
        ${extrasHtml}
        <div style="margin-top:16px;text-align:center;">
          <img
            src="${qrImageUrl(line.qrToken)}"
            alt="Código QR — ${serviceName}"
            width="200" height="200"
            style="border-radius:8px;"
          />
          <p style="font-size:12px;color:#777;margin:4px 0">Presenta este código QR al llegar</p>
        </div>
      </div>`
  }).join('')

  const paymentLabel = {
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
    link: 'Link de pago',
  }[data.paymentMethod]
  const orgName = escapeHtml(data.orgName)
  const greeting = data.customerName ? `Hola ${escapeHtml(data.customerName)},` : 'Hola,'
  const dateStr = data.createdAt.toLocaleDateString('es-MX', {
    day: '2-digit', month: 'long', year: 'numeric',
  })

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
      <h2 style="color:#1a1a2e">¡Tu reserva está confirmada!</h2>
      <p>${greeting}</p>
      <p>Tu compra en <strong>${orgName}</strong> ha sido confirmada.
         Aquí están los detalles de tu reserva.</p>

      <table style="width:100%;margin:8px 0;font-size:14px">
        <tr><td><strong>Folio</strong></td><td>#${shortId(data.folioId)}</td></tr>
        <tr><td><strong>Fecha</strong></td><td>${dateStr}</td></tr>
        <tr><td><strong>Pago</strong></td><td>${paymentLabel}</td></tr>
      </table>

      ${linesHtml}

      <p style="font-size:18px;font-weight:600;border-top:1px solid #e0e0e0;padding-top:12px;margin-top:4px;">
        Total pagado: ${formatAmount(data.total)}
      </p>

      ${
        data.portalLink
          ? `
      <div style="margin:24px 0;padding:16px;background:#f5f5f7;border-radius:8px;text-align:center;">
        <p style="margin:0 0 12px;font-weight:600;">Gestiona tu reserva en línea</p>
        <p style="margin:0 0 16px;font-size:14px;color:#555;">
          Consulta tu itinerario, descarga tus códigos QR o solicita una cancelación
          desde tu portal personal — sin crear cuenta.
        </p>
        <a href="${data.portalLink}"
           style="display:inline-block;background:#1a1a2e;color:#ffffff;text-decoration:none;
                  padding:10px 24px;border-radius:8px;font-size:14px;">
          Abrir mi portal
        </a>
        <p style="margin:12px 0 0;font-size:11px;color:#999;">
          Este enlace es personal — no lo compartas.
        </p>
      </div>`
          : ''
      }

      <p style="font-size:12px;color:#777;margin-top:24px;">
        ${orgName} — Gestión de reservas con GuideMe.
      </p>
    </div>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: data.to,
      subject: `Tu reserva está confirmada — ${data.orgName}`,
      html,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new ApiError('INTERNAL_ERROR', 502, `Resend error: ${body}`)
  }
}

// US-AG07 — apartado (booking) confirmation. NO scannable QR (the booking is not yet `paid`);
// the full ticket + QR email is sent only at settlement. Tells the customer the deposit was
// received, the pending balance, and the hold expiry so they know when to settle.
export interface BookingConfirmationEmailInput {
  to: string
  customerName: string | null
  orgName: string
  folioId: string
  createdAt: Date
  amountPaid: number
  total: number
  pendingBalance: number
  bookingExpiresAt: Date
  lines: Array<{
    serviceName: string
    slotDate: string // 'YYYY-MM-DD'
    slotStartTime: string // 'HH:MM'
    quantity: number
  }>
}

export const sendBookingConfirmationEmail = async (
  env: CloudflareBindings,
  data: BookingConfirmationEmailInput,
): Promise<void> => {
  const orgName = escapeHtml(data.orgName)
  const greeting = data.customerName ? `Hola ${escapeHtml(data.customerName)},` : 'Hola,'
  const expiresStr = data.bookingExpiresAt.toLocaleString('es-MX', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  const linesHtml = data.lines
    .map(
      (line) => `
      <div style="border:1px solid #e0e0e0;border-radius:8px;padding:12px;margin:12px 0;">
        <h3 style="margin:0 0 6px">${escapeHtml(line.serviceName)}</h3>
        <p style="margin:4px 0">📅 <strong>${line.slotDate}</strong> — ${line.slotStartTime}</p>
        <p style="margin:4px 0">👥 Personas: ${line.quantity}</p>
      </div>`,
    )
    .join('')

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
      <h2 style="color:#1a1a2e">¡Tu apartado está registrado!</h2>
      <p>${greeting}</p>
      <p>Hemos registrado tu apartado en <strong>${orgName}</strong> y reservado tus lugares.
         Para asegurarlos, liquida el saldo restante antes de la fecha límite.</p>

      ${linesHtml}

      <table style="width:100%;margin:8px 0;font-size:14px">
        <tr><td><strong>Folio</strong></td><td>#${shortId(data.folioId)}</td></tr>
        <tr><td><strong>Anticipo recibido</strong></td><td>${formatAmount(data.amountPaid)}</td></tr>
        <tr><td><strong>Total</strong></td><td>${formatAmount(data.total)}</td></tr>
        <tr><td><strong>Saldo pendiente</strong></td><td><strong>${formatAmount(data.pendingBalance)}</strong></td></tr>
        <tr><td><strong>Vence</strong></td><td>${expiresStr}</td></tr>
      </table>

      <p style="font-size:13px;color:#777;margin-top:16px;">
        Tu código QR de acceso se generará al liquidar el saldo. ${orgName} — GuideMe.
      </p>
    </div>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: data.to,
      subject: `Tu apartado está registrado — ${data.orgName}`,
      html,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new ApiError('INTERNAL_ERROR', 502, `Resend error: ${body}`)
  }
}

export interface CancellationEmailInput {
  to: string
  customerName: string | null
  orgName: string
  folioId: string
  cancelledAt: Date
  cancellationReason: string | null
  lines: Array<{
    serviceName: string
    slotDate: string
    slotStartTime: string
    quantity: number
  }>
}

export const sendCancellationEmail = async (
  env: CloudflareBindings,
  data: CancellationEmailInput,
): Promise<void> => {
  const orgName = escapeHtml(data.orgName)
  const greeting = data.customerName ? `Hola ${escapeHtml(data.customerName)},` : 'Hola,'
  const servicesHtml = data.lines
    .map(
      (l) =>
        `<li>${escapeHtml(l.serviceName)} — ${l.slotDate} ${l.slotStartTime} (×${l.quantity})</li>`,
    )
    .join('')
  const reasonHtml = data.cancellationReason
    ? `<p><strong>Motivo:</strong> ${escapeHtml(data.cancellationReason)}</p>`
    : ''

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
      <h2 style="color:#c62828">Tu reserva ha sido cancelada</h2>
      <p>${greeting}</p>
      <p>Lamentamos informarte que tu reserva en <strong>${orgName}</strong>
         ha sido cancelada.</p>

      <p><strong>Folio:</strong> #${shortId(data.folioId)}</p>

      <p><strong>Servicios cancelados:</strong></p>
      <ul>${servicesHtml}</ul>

      ${reasonHtml}

      <p>Si tienes alguna pregunta, comunícate directamente con
         <strong>${orgName}</strong>.</p>

      <p style="font-size:12px;color:#777;margin-top:24px;">
        ${orgName} — Gestión de reservas con GuideMe.
      </p>
    </div>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: data.to,
      subject: `Tu reserva ha sido cancelada — ${data.orgName}`,
      html,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new ApiError('INTERNAL_ERROR', 502, `Resend error: ${body}`)
  }
}
