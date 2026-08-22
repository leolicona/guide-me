// Shared meta-line label for a folio line — handles both tour (slot) and lodging (stay) lines.
// Used by the receipt, history-detail, and admin-detail folio pages.

const WEEKDAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

// "Sáb 10" for a YYYY-MM-DD (UTC getters, matching the engine's date math).
const dayShort = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()}`
}

/** A line's structural shape across the POS + admin folio types (subset they share). */
interface LabelableLine {
  line_type?: 'slot' | 'stay' | null
  slot_date?: string | null
  slot_start_time?: string | null
  /** US-A64 — the physical zone (Turibus deck), when the tour is zoned. */
  zone_name?: string | null
  check_in?: string | null
  check_out?: string | null
  guests?: number | null
  nights?: number | null
  quantity: number
}

/** The secondary meta line under a folio line's name: a stay shows its range · nights · guests
 * (· rooms when > 1 — v2 unit-type quantities), a tour shows its date · time · quantity. */
export function folioLineMeta(line: LabelableLine): string {
  if (line.line_type === 'stay' && line.check_in && line.check_out) {
    const nights = line.nights ?? 0
    const guests = line.guests ?? 0
    const rooms = line.quantity > 1 ? ` · ${line.quantity} habitaciones` : ''
    return `${dayShort(line.check_in)} → ${dayShort(line.check_out)} · ${nights} ${
      nights === 1 ? 'noche' : 'noches'
    } · ${guests} ${guests === 1 ? 'huésped' : 'huéspedes'}${rooms}`
  }
  const zone = line.zone_name ? ` · ${line.zone_name}` : ''
  const when = line.slot_date ? `Salida: ${salidaLabel(line.slot_date, line.slot_start_time)}` : ''
  return `${when}${zone} · ${line.quantity}×`
}

// "Salida: 13 ago 2026, 11:30 a.m." — the departure as a human sentence, not a raw ISO pair.
// Slot strings are naive org-local wall-clock (US-A66): parse and format in UTC so nothing shifts.
const SALIDA_DATETIME = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
})
const SALIDA_DATE = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
})
/** Exported for the ticket card, which used to print the raw ISO pair two lines below this very
 *  sentence — «2026-09-07 · 08:00» under «Salida: 7 sep 2026, 8:00 a.m.» (design review, Should
 *  Fix 4). One departure, one way of saying it. */
export function salidaLabel(date: string, time?: string | null): string {
  return time
    ? SALIDA_DATETIME.format(new Date(`${date}T${time}:00Z`))
    : SALIDA_DATE.format(new Date(`${date}T00:00:00Z`))
}
