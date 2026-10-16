// devolada-transfer-verification — the app's mirror of the Devolada contract
// (specs/006-devolada-transfer-verification/contracts/turistear-api.md). The server decides every
// label and flag (constitution IV); the client maps codes to copy and never derives them.

/** contracts § Labels — the server's verdict on a payment link, first match wins. */
export type PaymentLinkLabel =
  | 'link_failed'
  | 'confirmed'
  | 'unapplied'
  | 'partial'
  | 'invalid'
  | 'not_received'
  | 'closed'
  | 'credit_paused'
  | 'needs_tracking_key'
  | 'validating'
  | 'awaiting_payment'

export type PaymentLinkKind = 'sale' | 'deposit' | 'settlement'

export type PaymentLinkState =
  | 'creating'
  | 'open'
  | 'paid'
  | 'expired'
  | 'closing'
  | 'closed'
  | 'failed'
  | 'abandoned'

export type DevoladaPaymentStatus =
  | 'validating'
  | 'queued_for_credit'
  | 'confirmed'
  | 'partial'
  | 'unapplied'
  | 'invalid'
  | 'expired'
  | 'superseded'

export interface PaymentLinkPayment {
  /** The id the resolve endpoint takes. */
  id: string
  status: DevoladaPaymentStatus
  asked: number
  claimed: number | null
  received: number | null
  match: 'exact' | 'short' | 'over' | null
  /** Devolada's receipt number (DV-…), shown as «Comprobante Devolada». */
  receipt_number: string | null
  verdict_at: number | null
  awaiting: 'payer_tracking_key' | null
  awaiting_reason: 'all_used' | 'ambiguous' | 'no_match' | 'unreadable' | null
  resolution: 'accepted' | 'dismissed' | 'returned' | null
}

/** contracts § PaymentLinkView — one payment link of a sale. Instants are epoch seconds. */
export interface PaymentLinkView {
  id: string
  kind: PaymentLinkKind
  folio_line_id: string | null
  state: PaymentLinkState
  amount: number
  /** The payer's page; returned to the sale's seller and to admins, who send it. */
  url: string | null
  expires_at: number
  closed_reason:
    | 'cancelled'
    | 'rejected'
    | 'amount_changed'
    | 'settled_otherwise'
    | 'verified_by_admin'
    | 'abandoned'
    | null
  label: PaymentLinkLabel
  /** null until the customer submits proof; otherwise the link's current payment. */
  payment: PaymentLinkPayment | null
}

/** Why a checkout or a settlement got no link (contracts § Checkout): a fallback signal, not an
 *  HTTP error — the sale was recorded on today's manual path. */
export type PaymentLinkError =
  | 'DEVOLADA_UNAVAILABLE'
  | 'DEVOLADA_CREDENTIAL_REJECTED'
  | 'DEVOLADA_BUSINESS_SUSPENDED'
  | 'DEVOLADA_CHANNEL_UNAVAILABLE'
  | 'PAYMENT_LINK_TOO_SHORT'

export type DevoladaConnectionStatus = 'connected' | 'broken' | 'disconnected'

export type DevoladaBrokenReason =
  | 'DEVOLADA_CREDENTIAL_REJECTED'
  | 'DEVOLADA_BUSINESS_SUSPENDED'
  | 'DEVOLADA_CHANNEL_UNAVAILABLE'

/** contracts § OrganizationDevoladaSummary — on `GET /organizations/me`, for every role. */
export interface OrganizationDevoladaSummary {
  status: 'not_connected' | DevoladaConnectionStatus
  mode: 'real' | 'test' | null
}

/** contracts § DevoladaConnectionView — admin only. */
export interface DevoladaConnectionView {
  status: DevoladaConnectionStatus
  mode: 'real' | 'test' | null
  key_hint: string | null
  connected_at: number
  connected_by: { id: string; name: string | null }
  broken_reason: DevoladaBrokenReason | null
  last_verdict_at: number | null
  credit_paused_since: number | null
  /** Each retired key that still has unresolved enlaces, so the admin does not revoke it yet. */
  previous_keys: { key_hint: string; pending_links: number }[]
  /** Read live from Devolada; null while disconnected or when Devolada cannot be reached. */
  webhook: {
    url: string | null
    /** null where this environment registers no address (local, previews). */
    is_ours: boolean | null
    consecutive_failures: number
    last_success_at: number | null
    last_failure_at: number | null
    failed_deliveries: number
  } | null
  health_error: 'DEVOLADA_UNAVAILABLE' | null
}
