// Pure date helpers for schedule materialization.
//
// Dates are naive org-local calendar strings ('YYYY-MM-DD'). All arithmetic is
// done against UTC midnight so it never drifts across DST boundaries — we only
// ever care about the calendar day, never a wall-clock instant.

/** Inclusive cap on a schedule's [start_date, end_date] window (one year). */
export const MAX_HORIZON_DAYS = 366

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Parse 'YYYY-MM-DD' → UTC-midnight epoch ms. Returns NaN for malformed input.
const toUtcMs = (date: string): number => Date.parse(`${date}T00:00:00Z`)

// Format a UTC-midnight epoch ms back to 'YYYY-MM-DD'.
const fromUtcMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/**
 * Inclusive day count between two 'YYYY-MM-DD' strings (start..end).
 * `daysBetween('2026-06-08', '2026-06-08')` → 0; one week later → 7.
 */
export const daysBetween = (start: string, end: string): number =>
  Math.round((toUtcMs(end) - toUtcMs(start)) / MS_PER_DAY)

/**
 * Every calendar date in [start, end] (inclusive) whose ISO weekday number
 * (0 = Sunday … 6 = Saturday, matching `Date.getUTCDay()`) is in `weekdays`.
 * Returned in ascending date order.
 */
export const datesInRangeMatchingWeekdays = (
  start: string,
  end: string,
  weekdays: number[],
): string[] => {
  const wanted = new Set(weekdays)
  const endMs = toUtcMs(end)
  const out: string[] = []

  for (let ms = toUtcMs(start); ms <= endMs; ms += MS_PER_DAY) {
    if (wanted.has(new Date(ms).getUTCDay())) {
      out.push(fromUtcMs(ms))
    }
  }

  return out
}
