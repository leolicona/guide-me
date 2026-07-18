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

// Short countdown label: "Vence en 3 h", "Vence en 2 d", or "Vencido" once past.
export const venceLabel = (expiresAt: number | null | undefined): string => {
  const h = hoursUntilExpiry(expiresAt)
  if (h == null) return ''
  if (h <= 0) return 'Vencido'
  if (h < 1) return `Vence en ${Math.round(h * 60)} min`
  if (h < 24) return `Vence en ${Math.round(h)} h`
  return `Vence en ${Math.round(h / 24)} d`
}
