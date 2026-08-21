// Naive-calendar date helpers for the POS (single-timezone MVP model — mirrors the API's
// `utcToday` / `addDays` in api-turistear/src/routes/pos/handler.ts). Dates are 'YYYY-MM-DD'
// strings compared lexicographically; no timezone math.

/**
 * Org-local "today" as a naive YYYY-MM-DD string (US-A66). When the org's IANA `tz` is known it is
 * computed in that zone via `Intl` — the single org-local clock all staff share — so the catalog
 * "Hoy" rolls over at the ORG's midnight, not each device's (this is what closes BUG-007). The
 * client pins this value to the API via `?today=` / `?from=`; the server independently derives the
 * same org-local day as its fallback. Absent a `tz` (org not yet loaded) it falls back to the
 * device's local calendar date, which staff at the location share anyway.
 */
export const todayStr = (tz?: string): string => {
  if (tz) {
    // 'en-CA' yields an ISO-shaped YYYY-MM-DD; `timeZone` resolves the org-local day.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  }
  const d = new Date()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * The org-local wall clock as a naive `HH:MM` (24h, zero-padded) — `todayStr`'s within-the-day
 * sibling, resolved in the same org zone for the same US-A66 reason: every screen must agree on
 * what time it is *at the location*, not on each device.
 *
 * Zero-padded 24h strings order lexicographically, so `slot.start_time <= nowHM(tz)` is a valid
 * "has it left?" test against `slots.start_time` with no epoch math — the client-side echo of the
 * server's `naiveEpoch(date, start_time, tz) <= now` (api-turistear/src/routes/dashboard/handler.ts).
 */
export const nowHM = (tz?: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    ...(tz ? { timeZone: tz } : {}),
    hour: '2-digit',
    minute: '2-digit',
    // h23 (not `hour12: false`, which yields "24:00" at midnight in some engines).
    hourCycle: 'h23',
  }).format(new Date())

/** Add `n` whole days to a YYYY-MM-DD string (UTC midnight arithmetic). */
export const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** The `YYYY-MM` month of a YYYY-MM-DD date string (or of `today` when omitted). */
export const monthOf = (date: string): string => date.slice(0, 7)

/** Shift a `YYYY-MM` month by `n` months, returning `YYYY-MM` (handles year rollover). */
export const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}

/** Number of days in a `YYYY-MM` month (handles leap February). */
export const daysInMonth = (month: string): number => {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * Weekday index (0 = Monday … 6 = Sunday) of the first day of a `YYYY-MM` month — the
 * count of leading blanks before day 1 in a Monday-first calendar grid.
 */
export const firstWeekdayMondayBased = (month: string): number => {
  const [y, m] = month.split('-').map(Number)
  const jsDay = new Date(Date.UTC(y, m - 1, 1)).getUTCDay() // 0 = Sunday … 6 = Saturday
  return (jsDay + 6) % 7
}

/** Monday-based weekday index (0 = Mon … 6 = Sun) of a YYYY-MM-DD date. */
const mondayIndexOf = (date: string): number =>
  (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7

/** An inclusive naive date range (`from <= to`). */
export interface DateWindow {
  from: string
  to: string
}

// US-AG35 / US-AG55 — the window the POS catalog lists when the agent has picked nothing: today
// through the COMING SUNDAY, Monday-first (es-MX). The formula is the same every day of the week;
// what changes is how much week is left — 7 days on a Monday, 1 on a Sunday.
export const defaultWindow = (today: string): DateWindow => ({
  from: today,
  to: addDays(today, 6 - mondayIndexOf(today)),
})

// US-AG55 (D14) — what the calendar chip reads at rest. It names the window's remaining EXTENT,
// which `defaultWindow`'s identical formula hides: one static string would read the same on a
// Monday listing a whole week and on a Sunday listing a single day. Sentence case, to sit beside
// «Categorías» on the strip (the "SÁB 14" pills are uppercase as ABBREVIATIONS, not as a style).
export const defaultWindowLabel = (today: string): string => {
  const idx = mondayIndexOf(today) // 0 = Mon … 6 = Sun
  if (idx <= 3) return 'Esta semana' // Mon–Thu — a working stretch of the week is still ahead
  if (idx <= 5) return 'Fin de semana' // Fri–Sat — what remains IS the weekend
  return 'Hoy' // Sunday — the window collapses to today, this app's established word for one day
}
