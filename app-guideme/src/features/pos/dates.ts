// Naive-calendar date helpers for the POS (single-timezone MVP model — mirrors the API's
// `utcToday` / `addDays` in api-guideme/src/routes/pos/handler.ts). Dates are 'YYYY-MM-DD'
// strings compared lexicographically; no timezone math.

/**
 * Org-local "today" as a naive YYYY-MM-DD string — the DEVICE's local calendar date
 * (single-timezone MVP: staff operate in the org's timezone). NOT `toISOString()`:
 * that is the UTC date, which rolls over hours early (BUG-007 — in UTC-6 the catalog's
 * "Hoy" anchored on tomorrow from ~6 pm, hiding the rest of today's slots). The client
 * pins this value to the API via `?today=` / `?from=`, overriding the server's UTC fallback.
 */
export const todayStr = (): string => {
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
