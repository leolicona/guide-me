// Apartado (booking) domain — shared by every folio surface (agent POS + admin folios). Both
// features depend on THIS module; it never imports back into pos/ or folios/, so the dependency
// graph stays one-way (D9 — no dedicated booking screen; affordances integrate into the existing
// lists/detail).
export * from './bookingUrgency'
export * from './hooks/useBookingActions'
export { BookingActions, ExpiredBookingBanner } from './components/BookingActions'
export type { BookingFolio } from './components/BookingActions'
export { BookingWhatsAppButton } from './components/BookingWhatsAppButton'
export type { ReminderTarget } from './components/BookingWhatsAppButton'
export { TicketWhatsAppButton } from './components/TicketWhatsAppButton'
export { DeliveryBadge } from './components/DeliveryBadge'
