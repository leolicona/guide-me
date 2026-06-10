import type { PaymentMethod } from '../types'

// US-AG29 — display labels for the electronic payment methods (cash is labelled in place).
export const METHOD_LABEL: Record<Exclude<PaymentMethod, 'cash'>, string> = {
  card: 'Tarjeta',
  transfer: 'Transferencia',
  link: 'Link de pago',
}

export const ELECTRONIC_METHODS = ['card', 'transfer', 'link'] as const
