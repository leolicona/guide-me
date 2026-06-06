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
  paymentMethod: 'cash' | 'card'
  total: number
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

  const paymentLabel = data.paymentMethod === 'card' ? 'Tarjeta' : 'Efectivo'
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
