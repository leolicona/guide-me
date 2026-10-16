// WhatsApp ticket delivery — the client half (docs/whatsapp-qr-delivery/whatsapp-qr-delivery.spec.md). Derives the
// delivery state (Pendiente → Enviado → Visto), holds the default message templates + placeholder
// engine, and builds the wa.me deep link the agent taps to send the portal link.

import { normalizePhone } from './phone'
import { formatMoney } from '../catalog/types'
import { formatCents } from '../../components/money'
import { addDays } from './dates'
import type { PaymentLinkKind, PaymentLinkView } from '../devolada/types'

// US-T07 (express-sale D9) — every rendered QR encodes the public ticket-page URL instead of the
// bare signed token, so a tourist's plain camera resolves to their ticket while the agent's
// scanner (which strips this wrapper) still redeems the same code.
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
export const ticketPageUrl = (qrToken: string): string => `${API_BASE}/t/${qrToken}`

// Structural line shape for {itinerary} — satisfied by both the POS `FolioLine` and the admin
// `FolioDetailLine`, so this module never couples to either concrete folio type.
export interface ItineraryLine {
  service_name: string
  line_type?: 'slot' | 'stay'
  slot_date?: string | null
  slot_start_time?: string | null
  check_in?: string | null
  check_out?: string | null
  guests?: number | null
  quantity: number
}

export type DeliveryState = 'none' | 'pending' | 'sent' | 'viewed'

/** A folio is "on the delivery axis" once a portal link exists (paid folio). `none` = off-axis
 *  (unpaid booking / cancelled / pre-feature). Otherwise: viewed > sent > pending. */
export function deliveryState(f: {
  portal_link?: string | null
  deliverable?: boolean
  tickets_sent_at?: number | null
  tickets_viewed_at?: number | null
}): DeliveryState {
  const onAxis = !!f.portal_link || !!f.deliverable
  if (!onAxis) return 'none'
  if (f.tickets_viewed_at) return 'viewed'
  if (f.tickets_sent_at) return 'sent'
  return 'pending'
}

// --- Templates (D10/D11) — one generic delivery template for tours + lodging, one apartado
// reminder. Admin-edited copies live on the org; NULL there ⇒ these shipped defaults. ------------

export const DEFAULT_TICKET_TEMPLATE =
  'Hola {customer_name}, te escribe {agent_name} de {org_name}. Aquí está tu reserva y tus boletos:\n{itinerary}\nÁbrelos (y guarda el enlace) aquí: {portal_link}\n¡Buen viaje!'

export const DEFAULT_REMINDER_TEMPLATE =
  'Hola {customer_name}, te escribe {agent_name} de {org_name}. Tu apartado tiene un saldo pendiente de {pending_balance}. Puedes liquidarlo directamente conmigo para asegurar tus lugares. ¡Te esperamos!'

export const TEMPLATE_PLACEHOLDERS = [
  '{customer_name}',
  '{agent_name}',
  '{org_name}',
  '{folio_ref}',
  '{total}',
  '{pending_balance}',
  '{portal_link}',
  '{itinerary}',
] as const

/** {itinerary} — one line per folio line. Tour: name · date · time · pax; lodging: name ·
 *  checkin–checkout · guests. */
function renderItinerary(lines: ItineraryLine[]): string {
  return lines
    .map((l) => {
      const isStay = l.line_type === 'stay' || !!l.check_in
      if (isStay) {
        const guests = l.guests ? ` · ${l.guests} huésped${l.guests === 1 ? '' : 'es'}` : ''
        return `• ${l.service_name} · ${l.check_in ?? ''}–${l.check_out ?? ''}${guests}`
      }
      const when = [l.slot_date, l.slot_start_time].filter(Boolean).join(' · ')
      return `• ${l.service_name}${when ? ` · ${when}` : ''} · ${l.quantity}p`
    })
    .join('\n')
}

export interface TemplateContext {
  folio: {
    id: string
    customer_name: string | null
    customer_phone: string | null
    total: number
    amount_paid: number
    pending_balance?: number
    lines: ItineraryLine[]
  }
  agentName: string
  orgName: string
  portalLink: string
}

// express-sale D29 — the addressee when the folio has no name (an Express sale, D17). A fallback
// at substitution time degrades ANY org-authored template shape — "Hola viajero," / "¡Hola
// viajero!" — where an empty string would leave "Hola ," in every WhatsApp-first send.
const NAMELESS_ADDRESSEE = 'viajero'

/** Substitute placeholders (D11). Unknown `{tokens}` are left untouched. */
export function fillTemplate(template: string, ctx: TemplateContext): string {
  const f = ctx.folio
  const map: Record<string, string> = {
    '{customer_name}': f.customer_name || NAMELESS_ADDRESSEE,
    '{agent_name}': ctx.agentName,
    '{org_name}': ctx.orgName,
    '{folio_ref}': f.id.slice(0, 8),
    '{total}': formatMoney(f.total),
    '{pending_balance}': formatMoney(f.pending_balance ?? f.total - f.amount_paid),
    '{amount_paid}': formatMoney(f.amount_paid),
    '{portal_link}': ctx.portalLink,
    '{itinerary}': renderItinerary(f.lines),
  }
  return template.replace(/\{[a-z_]+\}/g, (m) => (m in map ? map[m] : m))
}

const whatsAppUrl = (rawPhone: string | null, text: string): string | null => {
  const phone = normalizePhone(rawPhone).e164
  if (!phone) return null
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
}

/** Build the wa.me deep link for a paid folio's ticket delivery. Null when the phone is unusable —
 *  or when there is no portal link: a ticket message without its link tells the customer their
 *  tickets are "aquí:" and then nothing (verify-send-empty-link). */
export function ticketWhatsAppUrl(template: string, ctx: TemplateContext): string | null {
  if (!ctx.portalLink) return null
  return whatsAppUrl(ctx.folio.customer_phone, fillTemplate(template, ctx))
}

// verify-send-empty-link — what an apartado's transfer verification says. The deposit cleared; the
// tickets do not exist until the balance settles. Shipped default, not org-editable (only the
// ticket and reminder templates are).
export const DEPOSIT_VERIFIED_TEMPLATE =
  'Hola {customer_name}, te escribe {agent_name} de {org_name}. Confirmamos tu anticipo de {amount_paid}. Tu saldo pendiente es {pending_balance}; tus boletos se envían al liquidarlo.'

/** The wa.me link confirming an apartado's verified deposit. Null when the phone is unusable. */
export function depositVerifiedWhatsAppUrl(ctx: Omit<TemplateContext, 'portalLink'>): string | null {
  return whatsAppUrl(
    ctx.folio.customer_phone,
    fillTemplate(DEPOSIT_VERIFIED_TEMPLATE, { ...ctx, portalLink: '' }),
  )
}

// --- devolada-transfer-verification — the payment link's message (contracts/turistear-api.md
// § The WhatsApp message for a link, FR-008). Shipped defaults, one per link kind, that the
// organization does not edit, like DEPOSIT_VERIFIED_TEMPLATE. Sending the enlace IS collecting the
// payment, so its action reads «Cobrar por WhatsApp». A deposit's text never promises tickets: an
// apartado's tickets wait for its settlement (bug verify-send-empty-link). ----------------------------

export const PAYMENT_LINK_TEMPLATES: Record<PaymentLinkKind, string> = {
  sale: 'Hola {customer_name}, te escribe {agent_name} de {org_name}. Para confirmar tu compra, transfiere {link_amount} desde tu banco con este enlace: {payment_link} (vence {link_expires}). En cuanto se confirme el pago te enviamos tus boletos.',
  deposit:
    'Hola {customer_name}, te escribe {agent_name} de {org_name}. Para apartar tu reserva, transfiere el anticipo de {link_amount} desde tu banco con este enlace: {payment_link} (vence {link_expires}). Tus boletos se envían al liquidar el saldo de {pending_balance}.',
  settlement:
    'Hola {customer_name}, te escribe {agent_name} de {org_name}. Para liquidar tu reserva, transfiere {link_amount} desde tu banco con este enlace: {payment_link} (vence {link_expires}). En cuanto se confirme el pago te enviamos tus boletos.',
}

const dayIn = (ms: number, tz?: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    ...(tz ? { timeZone: tz } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms))

const timeIn = (ms: number, tz?: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    ...(tz ? { timeZone: tz } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms))

/**
 * When a payment link expires, as a person says it: «hoy a las HH:MM» or «mañana a las HH:MM» in the
 * organization's time zone. A link lives at most 24 h (research D7), so it is always one of the two;
 * a stray other day reads «el DD/MM a las HH:MM» rather than lying.
 */
export function linkExpiryPhrase(expiresAt: number, tz?: string, nowMs: number = Date.now()): string {
  const ms = expiresAt * 1000
  const day = dayIn(ms, tz)
  const today = dayIn(nowMs, tz)
  const time = timeIn(ms, tz)
  if (day === today) return `hoy a las ${time}`
  if (day === addDays(today, 1)) return `mañana a las ${time}`
  return `el ${day.slice(8, 10)}/${day.slice(5, 7)} a las ${time}`
}

export interface PaymentLinkMessageContext extends Omit<TemplateContext, 'portalLink'> {
  /** The organization's IANA zone, for {link_expires}. */
  timezone?: string
  /** For tests: the instant «hoy» is measured from. */
  nowMs?: number
}

/**
 * The wa.me link that sends a payment link to the customer. The link's own tokens are filled first
 * ({link_amount}, {payment_link}, {link_expires}), then the shared ones by `fillTemplate`. Null when
 * the phone is unusable, or the link has no URL to send.
 */
export function paymentLinkWhatsAppUrl(
  link: Pick<PaymentLinkView, 'kind' | 'amount' | 'url' | 'expires_at'>,
  ctx: PaymentLinkMessageContext,
): string | null {
  if (!link.url) return null
  const own = PAYMENT_LINK_TEMPLATES[link.kind]
    .split('{link_amount}')
    .join(formatCents(link.amount))
    .split('{payment_link}')
    .join(link.url)
    .split('{link_expires}')
    .join(linkExpiryPhrase(link.expires_at, ctx.timezone, ctx.nowMs))
  return whatsAppUrl(ctx.folio.customer_phone, fillTemplate(own, { ...ctx, portalLink: '' }))
}
