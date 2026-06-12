// Naive-calendar date helpers for the POS (single-timezone MVP model — mirrors the API's
// `utcToday` / `addDays` in api-guideme/src/routes/pos/handler.ts). Dates are 'YYYY-MM-DD'
// strings compared lexicographically; no timezone math.

/** Org-local "today" as a naive YYYY-MM-DD string. */
export const todayStr = (): string => new Date().toISOString().slice(0, 10)

/** Add `n` whole days to a YYYY-MM-DD string (UTC midnight arithmetic). */
export const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
