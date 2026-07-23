// WhatsApp ticket delivery — the client half (docs/whatsapp-qr-delivery/spec.md). Derives the
// delivery state (Pendiente → Enviado → Visto), holds the default message templates + placeholder
// engine, and builds the wa.me deep link the agent taps to send the portal link.

import { normalizePhone } from './phone'
import { formatMoney } from '../catalog/types'

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

/** Substitute placeholders (D11). Unknown `{tokens}` are left untouched. */
export function fillTemplate(template: string, ctx: TemplateContext): string {
  const f = ctx.folio
  const map: Record<string, string> = {
    '{customer_name}': f.customer_name ?? '',
    '{agent_name}': ctx.agentName,
    '{org_name}': ctx.orgName,
    '{folio_ref}': f.id.slice(0, 8),
    '{total}': formatMoney(f.total),
    '{pending_balance}': formatMoney(f.pending_balance ?? f.total - f.amount_paid),
    '{portal_link}': ctx.portalLink,
    '{itinerary}': renderItinerary(f.lines),
  }
  return template.replace(/\{[a-z_]+\}/g, (m) => (m in map ? map[m] : m))
}

/** Build the wa.me deep link for a paid folio's ticket delivery. Null when the phone is unusable. */
export function ticketWhatsAppUrl(template: string, ctx: TemplateContext): string | null {
  const phone = normalizePhone(ctx.folio.customer_phone).e164
  if (!phone) return null
  return `https://wa.me/${phone}?text=${encodeURIComponent(fillTemplate(template, ctx))}`
}
