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
  check_in?: string | null
  check_out?: string | null
  guests?: number | null
  nights?: number | null
  quantity: number
}

/** The secondary meta line under a folio line's name: a stay shows its range · nights · guests,
 * a tour shows its date · time · quantity. */
export function folioLineMeta(line: LabelableLine): string {
  if (line.line_type === 'stay' && line.check_in && line.check_out) {
    const nights = line.nights ?? 0
    const guests = line.guests ?? 0
    return `${dayShort(line.check_in)} → ${dayShort(line.check_out)} · ${nights} ${
      nights === 1 ? 'noche' : 'noches'
    } · ${guests} ${guests === 1 ? 'huésped' : 'huéspedes'}`
  }
  return `${line.slot_date ?? ''} · ${line.slot_start_time ?? ''} · ${line.quantity}×`
}
