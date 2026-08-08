// US-AG07.3/07.5 — shared helpers for surfacing apartado (booking) urgency on the existing
// folio cards and the folio detail banner. No dedicated dashboard: these decorate screens the
// agent/admin already use (the folio lists + the folio detail).

const HOUR = 3600

// Hours until a booking expires (negative once past). Drives the urgency border + chip.
export const hoursUntilExpiry = (
  expiresAt: number | null | undefined,
): number | null =>
  expiresAt == null ? null : (expiresAt - Date.now() / 1000) / HOUR

// A booking is "urgent" when it expires within 24h (orange accent); otherwise it's safe (grey).
export const isUrgentBooking = (expiresAt: number | null | undefined): boolean =>
  (hoursUntilExpiry(expiresAt) ?? Infinity) < 24

// The countdown LABEL used to live here too (`venceLabel`), reading `Date.now()` in render —
// D19 (folio-lifecycle-unification) retired it: every surface now derives its time chip from
// `folioTimeChip` + `useNowSeconds` in `features/folios`.
