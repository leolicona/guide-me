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
