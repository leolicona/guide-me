import type { PaymentLinkView } from './types'

// devolada-transfer-verification data-model § devolada_links — a link's current payment is in
// flight while `validating` (awaiting included) or `queued_for_credit`: Devolada is still deciding
// it, and no write may close the link under it while the sale lives (research D13).
export const isPaymentInFlight = (link: Pick<PaymentLinkView, 'payment'>): boolean =>
  link.payment?.status === 'validating' || link.payment?.status === 'queued_for_credit'
