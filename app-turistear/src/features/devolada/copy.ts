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

// PR 2 (US2, US3) — contracts § Action copy.

/** Cancellation source `payment_not_received`, wherever cancellation sources are labelled (D11). */
export const PAYMENT_NOT_RECEIVED_SOURCE_COPY = 'No se recibió la transferencia'
/** Payment breakdown: a pending row of a sale cancelled with `payment_not_received`. */
export const PAYMENT_NOT_RECEIVED_ROW_COPY = 'No recibido'
/** The admin's resolve actions, one verb per action (research D15). */
export const RESOLVE_ACTION_COPY = {
  accept: 'Verificar',
  dismiss: 'Descartar',
  returned: 'Ya lo devolví',
} as const
/** BookingActions chip in place of the settle buttons while a settlement link is open (PR 2). */
export const SETTLEMENT_VERIFYING_COPY = 'Liquidación en verificación'
/** A line cancellation or a settlement refused with `SETTLEMENT_IN_PROGRESS` (D8, D19). */
export const SETTLEMENT_IN_PROGRESS_COPY =
  'La venta ya tiene un enlace de pago para liquidar; espera su resultado'

// PR 2 — the payment a person must weigh, and the admin's decisions on it (FR-015, research D15).

/** FR-022 — Devolada's receipt number (`DV-…`) is a «Comprobante Devolada», never a "folio". */
export const receiptNumberCopy = (receiptNumber: string): string =>
  `Comprobante Devolada ${receiptNumber}`

/** FR-015 — the words for a payment's three amounts. The claim is what the customer's receipt
 *  says, never money; the received amount is what Banxico says arrived (FR-020). */
export const PAYMENT_AMOUNT_COPY = {
  asked: 'Solicitado',
  claimed: 'Declarado',
  received: 'Recibido',
} as const

/** FR-015 — a payment's amounts, each with its word, in the order the admin weighs them: what the
 *  enlace asked, what the receipt claims, what arrived. An amount Devolada has not reported is left
 *  out rather than shown as zero: «Recibido $0.00» would say the money did not arrive. */
export const paymentAmountsCopy = (payment: {
  asked: number
  claimed: number | null
  received: number | null
}): { key: keyof typeof PAYMENT_AMOUNT_COPY; label: string; cents: number }[] =>
  (['asked', 'claimed', 'received'] as const)
    .filter((key) => payment[key] != null)
    .map((key) => ({ key, label: PAYMENT_AMOUNT_COPY[key], cents: payment[key] as number }))

/** The list card's single button on a sale whose Devolada payment needs the admin's decision: it
 *  opens the sale, where the decision is taken with the evidence in front of them. */
export const REVIEW_PAYMENT_COPY = 'Revisar pago'

/** The heading of the sale detail's Devolada rung: what the enlace collects. */
export const DEVOLADA_RUNG_TITLE: Record<'sale' | 'deposit' | 'settlement', string> = {
  sale: 'Pago por transferencia',
  deposit: 'Anticipo por transferencia',
  settlement: 'Liquidación por transferencia',
}

/** D15 — the line above the evidence, by the decisions the rung offers. */
export const DEVOLADA_DECISION_COPY = {
  /** A settlement exception, or one no key can read any more: «Verificar» or «Descartar» (D8). */
  decide:
    'Si confirmas que el cliente pagó la liquidación completa, verifícala; si no, descártala. El apartado no vence mientras decides.',
  /** A settlement exception on a sale that no longer expects it: «Descartar» alone. */
  dismiss:
    'Esta venta ya no espera esta liquidación. Si llegó dinero, devuélvelo al cliente y descarta el pago.',
  /** A settlement with no verdict yet: «Verificar» alone, never «Descartar» (D13). */
  in_flight:
    'Devolada todavía no da el veredicto de esta liquidación. Si ya confirmaste el pago, puedes verificarla tú.',
  /** Money that arrived for an enlace already closed, or for a sale cancelled meanwhile:
   *  «Ya lo devolví». */
  returned: 'Llegó dinero que esta venta ya no esperaba. Devuélvelo al cliente y regístralo aquí.',
} as const

/** D15 — the question each decision asks, and its one-line consequence. «Descartar» cancels
 *  nothing, unlike «Rechazar pago»; on an apartado that still owes, it says the apartado stays. */
export const resolveConfirmCopy = (
  action: keyof typeof RESOLVE_ACTION_COPY,
  { apartado }: { apartado: boolean },
): { title: string; description: string } => {
  switch (action) {
    case 'accept':
      return {
        title: '¿Verificar la liquidación?',
        description:
          'Se registra la liquidación como verificada por ti y, si la venta queda pagada, se liberan los boletos.',
      }
    case 'dismiss':
      return {
        title: '¿Descartar el pago?',
        description: `${
          apartado ? 'El apartado sigue vigente y no se cancela nada.' : 'No se cancela nada en la venta.'
        } Si llegó dinero, devuélvelo al cliente fuera del sistema.`,
      }
    case 'returned':
      return {
        title: '¿Ya devolviste el dinero?',
        description:
          'Registra que le devolviste al cliente el dinero que llegó por este enlace. No cambia ningún monto de la venta.',
      }
  }
}

/** D15 — why a decision was refused, inside its sheet. Both 409s are final: the payment was
 *  decided already, or the sale changed under it. Anything else can be tried again. */
export const RESOLVE_ERROR_COPY: Record<string, string> = {
  DEVOLADA_PAYMENT_NOT_RESOLVABLE: 'Este pago ya no admite esa acción: ya se resolvió o la venta cambió.',
  FOLIO_CANCELLED: 'La venta está cancelada: la liquidación ya no se puede verificar.',
}

export const resolveErrorCopy = (code: string | null | undefined): string =>
  (code && RESOLVE_ERROR_COPY[code]) || 'No se pudo registrar. Inténtalo de nuevo.'
