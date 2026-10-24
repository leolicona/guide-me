import { request } from './authService'
import type { DevoladaConnectionView } from '../features/devolada/types'
import type { FolioDetail } from '../features/folios/types'

// devolada-transfer-verification — the organization's Devolada connection, admin only
// (contracts/turistear-api.md § Connection). The key travels once, on connect; every answer carries
// only its last four characters.

export const getDevoladaConnection = async (): Promise<DevoladaConnectionView | null> => {
  const res = await request<{ connection: DevoladaConnectionView | null }>('/api/organizations/me/devolada')
  return res.connection
}

export interface ConnectDevoladaInput {
  api_key: string
  /** FR-006 — take Devolada's one notification address from whatever system holds it now. */
  replace_webhook?: boolean
}

export const connectDevolada = async (input: ConnectDevoladaInput): Promise<DevoladaConnectionView> => {
  const res = await request<{ connection: DevoladaConnectionView }>('/api/organizations/me/devolada', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
  return res.connection
}

export const disconnectDevolada = async (): Promise<DevoladaConnectionView | null> => {
  const res = await request<{ connection: DevoladaConnectionView | null }>('/api/organizations/me/devolada', {
    method: 'DELETE',
  })
  return res.connection
}

// devolada-transfer-verification D15 — the admin decides a Devolada payment that needs them
// (contracts/turistear-api.md § Resolving Devolada exceptions). `paymentId` is
// `PaymentLinkView.payment.id`. The server checks that the action fits the payment's status and its
// enlace's kind, and claims it with a guarded write, so a double tap answers 409
// `DEVOLADA_PAYMENT_NOT_RESOLVABLE` the second time; `accept` on a cancelled sale answers 409
// `FOLIO_CANCELLED`. The answer is the sale as it stands after the decision.
//
//   accept   — record a settlement as the admin: a settlement exception, or one still in flight
//   dismiss  — a settlement exception, or one in flight on an enlace no key can read; the apartado
//              stays and nothing is cancelled
//   returned — money that arrived for an enlace already closed was given back outside the system
export type ResolveDevoladaAction = 'accept' | 'dismiss' | 'returned'

export interface ResolveDevoladaPaymentInput {
  action: ResolveDevoladaAction
  /** At most 500 characters. */
  note?: string
}

export const resolveDevoladaPayment = (
  paymentId: string,
  input: ResolveDevoladaPaymentInput,
): Promise<{ folio: FolioDetail }> =>
  request<{ folio: FolioDetail }>(`/api/devolada/payments/${encodeURIComponent(paymentId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
