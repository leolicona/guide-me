import { formatMoney } from '../catalog/types'

// US-AG51 (D12/D20) — the refund receipt, as a pure function.
//
// The action ends when the customer has been told, not when the sheet closes. Confirming a refund
// used to stop at `setRefundOpen(false)` and nobody was notified; the pattern that works already
// existed one screen away (`Verificar y enviar` verifies and sends in one tap).
//
// Why this message exists at all, since the cash and the PIN already confirmed it in the moment:
// afterwards the company holds the entire record — `refunded_at`, `refunded_by`, `refund_amount`,
// the PIN attempts — and the customer holds cash and nothing else. "Pagué 3,000 y recibí 1,800,
// ¿dónde quedaron 1,200?" is answered nowhere else in the product; the ladder's retention is shown
// to them on no screen. So the three figures are spelled out (business rule 13).

export interface RefundReceiptFolio {
  id: string
  customer_name: string | null
  customer_phone?: string | null
  amount_paid: number
  refund_amount?: number | null
}

/** The retention: what the ladder kept. Derived, never negative — `amount_paid − refund`. */
export const retainedCents = (f: RefundReceiptFolio): number =>
  Math.max(0, f.amount_paid - (f.refund_amount ?? 0))

export const refundReceiptText = (f: RefundReceiptFolio): string =>
  `Hola ${f.customer_name ?? ''}, confirmamos tu reembolso del folio ${f.id.slice(0, 8).toUpperCase()}. ` +
  `Pagaste ${formatMoney(f.amount_paid)}, te devolvimos ${formatMoney(f.refund_amount ?? 0)} ` +
  `y se retuvo ${formatMoney(retainedCents(f))} según la política de cancelación.`

/**
 * The composer URL, or `null` when there is no phone to reach.
 *
 * A `wa.me` deep link is the only way to reach WhatsApp from here — a Worker cannot send one
 * (`apartado-stages.spec.md` S4) — which is precisely why this belongs chained to the action rather
 * than in a queue: the human is already holding the phone.
 */
export const refundReceiptUrl = (f: RefundReceiptFolio): string | null => {
  const digits = (f.customer_phone ?? '').replace(/\D/g, '')
  if (!digits) return null
  return `https://wa.me/${digits}?text=${encodeURIComponent(refundReceiptText(f))}`
}
