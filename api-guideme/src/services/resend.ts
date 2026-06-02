import { ApiError } from '../types/errors'

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
