// US-A82/US-AG49 — everything the folio card derives, in one place, so the two list surfaces cannot
// disagree about what a row means. Spec: docs/oversight/folio-list-scanability.spec.md.
//
// The organising rule is D1: one channel per axis. Each function below owns exactly one channel —
// rail = money, mark = message, button = pending work — and none of them reads another's inputs.

import { normalizePhone } from '../pos/phone'
import { deliveryState } from '../pos/delivery'
import type { FolioListLine } from '../pos/types'

// --- Identity (D3) -------------------------------------------------------------------------------

/**
 * The card's identity line. Degrades, never blanks: a name, else the phone's last four digits,
 * else the bare noun.
 *
 * `Sin nombre` is deliberately NOT a fallback here. An Express sale has no name **by design**
 * (`express-sale.spec.md` D17) and we hold a phone that identifies it — calling that record
 * nameless states a deficiency where there is none. This is the fallback that spec prescribed
 * at line 490 and nobody built.
 */
export type CustomerIdentity =
  | { kind: 'name'; text: string }
  | { kind: 'masked'; tail: string }
  | { kind: 'anon' }

/** The identity as STRUCTURE, so the card can render the mask's bullets with their own tracking —
 *  in Manrope the two `•` carry enough side bearing to read as a typo rather than a mask, and that
 *  is a rendering concern the label string cannot express. */
export function folioCustomerIdentity(folio: {
  customer_name?: string | null
  customer_phone?: string | null
}): CustomerIdentity {
  const name = folio.customer_name?.trim()
  if (name) return { kind: 'name', text: name }
  const digits = normalizePhone(folio.customer_phone).e164.replace(/\D/g, '')
  return digits.length >= 4 ? { kind: 'masked', tail: digits.slice(-4) } : { kind: 'anon' }
}

export function folioCustomerLabel(folio: {
  customer_name?: string | null
  customer_phone?: string | null
}): string {
  const identity = folioCustomerIdentity(folio)
  if (identity.kind === 'name') return identity.text
  if (identity.kind === 'masked') return `Cliente ••${identity.tail}`
  return 'Cliente'
}

// --- The money axis: the rail, and how the figure reads (D4 · D5 · D6) ---------------------------

export type RailTone = 'success' | 'warning' | 'error'

/** What the money figure says, beside the amount it says it about. */
export type MoneyReading =
  | { kind: 'paid'; cents: number }
  | { kind: 'unverified'; cents: number }
  | { kind: 'owing'; paid: number; total: number }
  | { kind: 'refundOwed'; cents: number }
  | { kind: 'refundSettled'; cents: number }

export interface MoneyAxis {
  rail: RailTone
  reading: MoneyReading
}

/**
 * The rail carries the money axis and nothing else (D4) — apartado urgency lives in the countdown
 * chip, delivery in the checkmarks. Three values, because a 4px border can carry three.
 *
 * A `paid` folio whose electronic payment is still `pending` reads AMBER, not green (D5): the
 * organization does not have that money, and the green pill this replaces was a factual error.
 */
export function folioMoneyAxis(folio: {
  status: 'paid' | 'booking' | 'cancelled'
  total: number
  amount_paid: number
  pending_balance?: number
  payment_verification?: 'not_required' | 'pending' | 'verified'
  refund_status?: 'none' | 'pending' | 'refunded'
  refund_amount?: number | null
}): MoneyAxis {
  if (folio.status === 'cancelled') {
    return folio.refund_status === 'pending'
      ? { rail: 'error', reading: { kind: 'refundOwed', cents: folio.refund_amount ?? 0 } }
      : { rail: 'error', reading: { kind: 'refundSettled', cents: folio.total } }
  }
  if (folio.status === 'booking') {
    return {
      rail: 'warning',
      reading: {
        kind: 'owing',
        paid: folio.pending_balance ?? folio.total - folio.amount_paid,
        total: folio.total,
      },
    }
  }
  if (folio.payment_verification === 'pending') {
    return { rail: 'warning', reading: { kind: 'unverified', cents: folio.total } }
  }
  return { rail: 'success', reading: { kind: 'paid', cents: folio.amount_paid } }
}

// --- The message axis: the checkmarks (D11) ------------------------------------------------------

export type DeliveryMark = 'none' | 'sent' | 'viewed'

/**
 * Two marks, never three. `✓` = the seller opened the composer; `✓✓` = the tourist's browser fired
 * the portal beacon. There is deliberately no middle "delivered" mark: WhatsApp's grey `✓✓` means
 * the device received the message, and no column here backs that claim.
 */
export function folioDeliveryMark(folio: Parameters<typeof deliveryState>[0]): DeliveryMark {
  const state = deliveryState(folio)
  if (state === 'viewed') return 'viewed'
  if (state === 'sent') return 'sent'
  return 'none'
}

// --- The work axis: the single button (D7 · D8) --------------------------------------------------

/** `tickets`/`reminder` are pending jobs and render filled; `message` is the neutral resting verb. */
export type FolioAction = 'tickets' | 'reminder' | 'message'

/**
 * Exactly one action per card, and its verb is the folio's first pending job.
 *
 * Why the specific and the generic verb never coexist (D7): were both offered, a seller would send
 * the portal link through the generic button, `tickets_sent_at` would never be written, and the
 * folio would sit in the undelivered queue forever — a queue that grows from correct behaviour.
 */
export function folioAction(
  folio: Parameters<typeof deliveryState>[0] & {
    status: 'paid' | 'booking' | 'cancelled'
    booking_expires_at?: number | null
  },
  opts: { urgent: boolean },
): FolioAction {
  if (folio.status === 'paid' && deliveryState(folio) === 'pending') return 'tickets'
  if (folio.status === 'booking' && opts.urgent) return 'reminder'
  return 'message'
}

// --- The sale time, compressed (D6) --------------------------------------------------------------

/** The org-local calendar day of an instant, as `YYYY-MM-DD`. `en-CA` is the locale that formats
 *  dates in that order — used as a key, never shown. */
const orgDay = (unixSeconds: number, tz?: string): string =>
  new Date(unixSeconds * 1000).toLocaleDateString('en-CA', { timeZone: tz })

/** Calendar arithmetic on the day string, not `now − 86400`: subtracting a fixed number of seconds
 *  lands on the wrong day across a DST boundary, and this list is read in a timezone that has one. */
const previousDay = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * "hoy 14:32" · "ayer 09:05" · "28 jul" · "28 jul 2025".
 *
 * The full `1 ago 2026, 02:32 p.m.` the card used to print is nine characters of ceremony on a line
 * that also has to carry the customer and the seller. Recency is what the reader actually wants
 * from a sale timestamp — the exact instant is one tap away on the detail — so the near days get
 * words and a time, and everything older collapses to a date. Rendered in the ORG's zone (US-A66):
 * "hoy" must mean the counter's today, not the viewer's.
 */
export function folioSoldAtLabel(
  unixSeconds: number,
  nowSeconds: number | null,
  tz?: string,
): string {
  const day = orgDay(unixSeconds, tz)
  const time = new Date(unixSeconds * 1000).toLocaleTimeString('es-MX', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  // `now` is null on the first render (useNowSeconds resolves in an effect). Fall back to the
  // absolute date rather than guessing "hoy" — a wrong "hoy" is worse than a right date.
  if (nowSeconds !== null) {
    const today = orgDay(nowSeconds, tz)
    if (day === today) return `hoy ${time}`
    if (day === previousDay(today)) return `ayer ${time}`
  }

  const sameYear = nowSeconds !== null && day.slice(0, 4) === orgDay(nowSeconds, tz).slice(0, 4)
  return new Date(unixSeconds * 1000).toLocaleDateString('es-MX', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

// --- The title: what was sold (D2) ---------------------------------------------------------------

export interface SoldSummary {
  /** The first line's service name; null when the folio carries no lines (pre-feature rows). */
  name: string | null
  /** Its date/time, already formatted for the title. Empty when the line has neither. */
  when: string
  /** How many further lines the folio has. */
  more: number
}

const WEEKDAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

/** "Sáb 10" for a YYYY-MM-DD, using UTC getters to match the engine's date math. */
const dayShort = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()}`
}

/**
 * The card title (D2): the FIRST line — the server orders them by `created_at`, so it is the same
 * line the detail page leads with — plus a count of the rest.
 *
 * The title is the service and not the customer because **a folio always has a line; since Express
 * it does not always have a name**. A title has to be a field that always exists.
 */
export function folioSoldSummary(lines: FolioListLine[] | undefined): SoldSummary {
  const first = lines?.[0]
  if (!first) return { name: null, when: '', more: 0 }

  const isStay = first.line_type === 'stay' || !!first.check_in
  const when = isStay
    ? first.check_in && first.check_out
      ? `${dayShort(first.check_in)} → ${dayShort(first.check_out)}`
      : ''
    : [first.slot_date ? dayShort(first.slot_date) : '', first.slot_start_time ?? '']
        .filter(Boolean)
        .join(', ')

  return { name: first.service_name, when, more: (lines?.length ?? 1) - 1 }
}
