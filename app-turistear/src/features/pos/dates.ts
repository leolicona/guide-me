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

export type ContextPillKey = 'esta_semana' | 'este_fin' | 'sig_semana'

export interface ContextPill {
  key: ContextPillKey
  label: string
  from: string
  to: string
}

const PILL_LABELS: Record<ContextPillKey, string> = {
  esta_semana: 'ESTA SEMANA',
  este_fin: 'ESTE FIN',
  sig_semana: 'SIG. SEMANA',
}

// US-AG35 — the dynamic, week-based context pills that adapt to the current day of the week
// (Monday-first, es-MX). Mon–Thu offer "ESTA SEMANA" (today → Sunday, default) + "ESTE FIN"
// (Fri → Sun); Fri–Sun offer "ESTE FIN" (today → Sun, default) + "SIG. SEMANA" (next Mon → Sun).
// The FIRST pill is the contextual default. All ranges are inclusive naive YYYY-MM-DD.
export const contextPills = (today: string): ContextPill[] => {
  const idx = mondayIndexOf(today) // 0 = Mon … 6 = Sun
  const comingSunday = addDays(today, 6 - idx)
  const pill = (key: ContextPillKey, from: string, to: string): ContextPill => ({
    key,
    label: PILL_LABELS[key],
    from,
    to,
  })

  if (idx <= 3) {
    // Monday–Thursday.
    const thisFriday = addDays(today, 4 - idx)
    return [
      pill('esta_semana', today, comingSunday),
      pill('este_fin', thisFriday, comingSunday),
    ]
  }
  // Friday–Sunday.
  const nextMonday = addDays(comingSunday, 1)
  const nextSunday = addDays(nextMonday, 6)
  return [
    pill('este_fin', today, comingSunday),
    pill('sig_semana', nextMonday, nextSunday),
  ]
}
