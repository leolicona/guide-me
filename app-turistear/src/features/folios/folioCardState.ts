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

// --- The work axis: the single button (D7 · D8 · US-A84 D12) -------------------------------------

/**
 * The verbs the single button can carry. `message` is the neutral resting verb; everything else is
 * a pending job and renders filled.
 *
 * `request`/`verify`/`refund` are ADMIN verbs — US-A84 D15 draws the audience line at capability,
 * so `folioAction` is told which surface is asking rather than guessing from the data.
 */
export type FolioAction = 'request' | 'verify' | 'refund' | 'tickets' | 'reminder' | 'message'

/**
 * Exactly one action per card, and its verb is the folio's first pending job.
 *
 * Why the specific and the generic verb never coexist (D7): were both offered, a seller would send
 * the portal link through the generic button, `tickets_sent_at` would never be written, and the
 * folio would sit in the undelivered queue forever — a queue that grows from correct behaviour.
 *
 * US-A84 D12 — the ladder is BLOCKING-FIRST, because two jobs can now land on one folio (an overdue
 * hold whose customer has asked to cancel). Reviewing the request can make everything below it
 * moot; an unverified payment makes delivery impossible (`deliverable` is false), so offering
 * `Enviar boletos` there would be a button that cannot work. Ordering by age instead would make the
 * same card change its verb on its own, which nobody can plan around.
 */
export function folioAction(
  folio: Parameters<typeof deliveryState>[0] & {
    status: 'paid' | 'booking' | 'cancelled'
    booking_expires_at?: number | null
    payment_verification?: 'not_required' | 'pending' | 'verified'
    refund_status?: 'none' | 'pending' | 'refunded'
    cancellation_request?: 'pending' | 'resolved' | null
  },
  opts: { urgent: boolean; surface?: 'admin' | 'seller' },
): FolioAction {
  if (opts.surface !== 'seller') {
    // 1 — a customer is waiting on an answer, and the answer changes the rest.
    if (folio.cancellation_request === 'pending') return 'request'
    // 2 — money the company does not hold yet, blocking delivery downstream.
    if (folio.status !== 'cancelled' && folio.payment_verification === 'pending') return 'verify'
    // 3 — money the company owes and has not handed back.
    if (folio.refund_status === 'pending') return 'refund'
  }
  if (folio.status === 'paid' && deliveryState(folio) === 'pending') return 'tickets'
  if (folio.status === 'booking' && opts.urgent) return 'reminder'
  return 'message'
}

// --- The time axis: the chip (D1 · US-A84 D10 · D19) ---------------------------------------------

export type TimeChipTone = 'default' | 'warning' | 'error'

export interface TimeChip {
  label: string
  tone: TimeChipTone
}

const HOUR = 3600
const DAY = 24 * HOUR

/** "hace 40 min" · "hace 5 h" · "hace 3 d" — coarse on purpose. An exact timestamp answers a
 *  question nobody asked; the reader wants to know whether this is old. */
const ago = (seconds: number): string => {
  const s = Math.max(0, seconds)
  if (s < HOUR) return `${Math.max(1, Math.floor(s / 60))} min`
  if (s < DAY) return `${Math.floor(s / HOUR)} h`
  return `${Math.floor(s / DAY)} d`
}

/**
 * The card's time channel — ONE chip, whichever clock this folio is actually running against.
 *
 * `nowSeconds` is an ARGUMENT, never `Date.now()` read inside a render (D19). `venceLabel` did
 * exactly that (`bookingUrgency.ts:11`), which was harmless while the label was the static word
 * `Vencido` and is not once it says *how long ago*: a booth tablet left open all morning would
 * print a dead number, and Q5 of `pending-work-queues.spec.md` already ruled that a stale age is a
 * wrong screen rather than a cosmetic one. `null` ⇒ the clock has not resolved yet, so the chip
 * states the fact without the age instead of guessing zero.
 *
 * The refund debt outranks the hold because a cancelled folio has no live hold to report.
 */
export function folioTimeChip(
  folio: {
    status: 'paid' | 'booking' | 'cancelled'
    booking_expires_at?: number | null
    cancelled_at?: number | null
    refund_status?: 'none' | 'pending' | 'refunded'
  },
  nowSeconds: number | null,
): TimeChip | null {
  if (folio.refund_status === 'pending') {
    const since = nowSeconds !== null && folio.cancelled_at != null ? nowSeconds - folio.cancelled_at : null
    return { label: since === null ? 'Reembolso pendiente' : `Debe hace ${ago(since)}`, tone: 'error' }
  }

  if (folio.status !== 'booking' || folio.booking_expires_at == null) return null

  const expires = folio.booking_expires_at
  if (nowSeconds === null) return { label: 'Apartado', tone: 'default' }

  // US-A84 — `Vencido` was ALREADY on this card (`venceLabel`), silent about the age and drawn
  // amber. A passed deadline is not a warning about the future; it is a fact about the past.
  if (expires <= nowSeconds) return { label: `Venció hace ${ago(nowSeconds - expires)}`, tone: 'error' }

  const hours = (expires - nowSeconds) / HOUR
  const label =
    hours < 1
      ? `Vence en ${Math.round(hours * 60)} min`
      : hours < 24
        ? `Vence en ${Math.round(hours)} h`
        : `Vence en ${Math.round(hours / 24)} d`
  return { label, tone: hours < 24 ? 'warning' : 'default' }
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
