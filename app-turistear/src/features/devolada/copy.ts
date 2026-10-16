import type {
  DevoladaBrokenReason,
  DevoladaConnectionView,
  OrganizationDevoladaSummary,
  PaymentLinkError,
  PaymentLinkLabel,
} from './types'

// devolada-transfer-verification — every word this feature shows, in one place, as
// contracts/turistear-api.md § Labels and § Action copy state them (constitution VII: one word per
// concept, one verb per action). Money being checked is always *verificación*; the URL the customer
// opens is always an *enlace*; «liga» and «link» never appear.

/** The tone a label's chip takes: meaning only, never teal (§ Labels "Chip tone"). */
export type PaymentLinkTone = 'paid' | 'pending' | 'warning' | 'error' | 'neutral'

export const PAYMENT_LINK_LABEL_COPY: Record<PaymentLinkLabel, { text: string; tone: PaymentLinkTone }> = {
  link_failed: { text: 'Sin enlace de pago — verificar a mano', tone: 'warning' },
  confirmed: { text: 'Pago confirmado', tone: 'paid' },
  unapplied: { text: 'Dinero por devolver', tone: 'warning' },
  partial: { text: 'Pago incompleto', tone: 'warning' },
  invalid: { text: 'Banxico no confirma la transferencia', tone: 'error' },
  not_received: { text: 'No se recibió la transferencia', tone: 'error' },
  closed: { text: 'Enlace cerrado', tone: 'neutral' },
  credit_paused: { text: 'Verificación en pausa', tone: 'warning' },
  needs_tracking_key: { text: 'Pide al cliente su clave de rastreo', tone: 'warning' },
  validating: { text: 'Verificando pago', tone: 'pending' },
  awaiting_payment: { text: 'Esperando pago', tone: 'pending' },
}

/** § Action copy — the alert when a transfer got no enlace (`payment_link_error`, or a failed link). */
export const linkNotCreatedCopy = (error?: PaymentLinkError | null): string =>
  error === 'PAYMENT_LINK_TOO_SHORT'
    ? 'Ya no hay tiempo para cobrar con enlace; un administrador verificará la transferencia'
    : 'No se pudo crear el enlace de pago; un administrador verificará la transferencia'

/** § Action copy — the connect sheet's refusals; a broken connection's reason reuses the first three. */
export const DEVOLADA_ERROR_COPY: Record<string, string> = {
  DEVOLADA_CREDENTIAL_REJECTED: 'Devolada rechazó la clave',
  DEVOLADA_BUSINESS_SUSPENDED: 'Devolada suspendió tu negocio',
  DEVOLADA_CHANNEL_UNAVAILABLE: 'Completa en Devolada la configuración de cobro de tu negocio',
  DEVOLADA_MODE_NOT_ALLOWED: 'Esta clave no corresponde a este ambiente (real o de prueba)',
  DEVOLADA_UNAVAILABLE: 'No pudimos contactar a Devolada; intenta de nuevo',
  VALIDATION_ERROR: 'Revisa la clave: empieza con dk_',
  INTERNAL_ERROR: 'Devolada no está disponible en este ambiente',
}

export const brokenReasonCopy = (reason: DevoladaBrokenReason | null): string =>
  (reason && DEVOLADA_ERROR_COPY[reason]) || DEVOLADA_ERROR_COPY.DEVOLADA_UNAVAILABLE

/** § Action copy — checkout and SettleSheet, by the organization's connection. */
export const TRANSFER_BY_LINK_COPY = 'Se generará un enlace de pago para cobrar por WhatsApp'
export const TRANSFER_BROKEN_COPY =
  'El cobro con Devolada tiene fallas; un administrador verificará la transferencia'

/** A connect refusal by its `code`; anything unmapped reads as Devolada unreachable. */
export const devoladaErrorCopy = (code: string | null | undefined): string =>
  (code && DEVOLADA_ERROR_COPY[code]) || DEVOLADA_ERROR_COPY.DEVOLADA_UNAVAILABLE

// § Action copy — the Ajustes card «Cobro con Devolada» (research D16, D21). The API key is always a
// «clave»: «llave» already names the passkeys, the «llave de acceso» (specs/004-passkey-auth).

/** Never connected and disconnected both read «Sin conectar». */
export const CONNECTION_STATUS_COPY: Record<OrganizationDevoladaSummary['status'], string> = {
  connected: 'Conectada',
  broken: 'Con fallas',
  disconnected: 'Sin conectar',
  not_connected: 'Sin conectar',
}

export const CONNECTION_MODE_COPY: Record<NonNullable<DevoladaConnectionView['mode']>, string> = {
  real: 'Real',
  test: 'Prueba',
}

/** FR-003 — the key's last four characters are all any answer carries. */
export const keyHintCopy = (keyHint: string): string => `Clave …${keyHint}`

/** FR-005 — the notification health. `periodic_only` is an environment that registers no address
 *  (local, previews): verdicts arrive by the sweep, which is expected rather than a failure (D3). */
export type ConnectionHealth = 'working' | 'failing' | 'credit_paused' | 'periodic_only'

export const CONNECTION_HEALTH_COPY: Record<ConnectionHealth, string> = {
  working: 'Avisos funcionando',
  failing: 'Avisos con fallas',
  credit_paused: 'Verificación en pausa',
  periodic_only: 'Avisos: solo revisión periódica',
}

export const lastVerdictCopy = (when: string): string => `Último veredicto: ${when}`

/** D21 — one line per retired key that still has pending enlaces, so the admin does not revoke it
 *  at Devolada before they finish. */
export const previousKeyCopy = ({
  key_hint,
  pending_links,
}: DevoladaConnectionView['previous_keys'][number]): string =>
  `La clave anterior …${key_hint} todavía tiene ${
    pending_links === 1 ? '1 enlace pendiente' : `${pending_links} enlaces pendientes`
  }. No la revoques en Devolada hasta que terminen.`

/** The «Referencia obligatoria en transferencias» switch while connected. */
export const REFERENCE_SWITCH_CONNECTED_COPY =
  'Con Devolada conectado, las transferencias se cobran con enlace de pago'
