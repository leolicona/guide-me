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
