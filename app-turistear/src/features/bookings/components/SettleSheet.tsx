import { useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import { FormSheet } from '../../../components/FormSheet'
import { MoneyText } from '../../../components/MoneyText'
import { ServiceError } from '../../../services/authService'
import {
  PaymentLinkCard,
  SETTLEMENT_IN_PROGRESS_COPY,
  type PaymentLinkError,
} from '../../devolada'
import { useMyOrganization } from '../../organization'
// devolada-transfer-verification D16 — the transfer fields checkout uses, so a balance asks for its
// reference, or announces its enlace, exactly as a sale does.
import { TransferPaymentFields } from '../../pos/components/TransferPaymentFields'
import type { Folio, PaymentMethod } from '../../pos/types'
import { useSettleBooking } from '../hooks/useBookingActions'

// US-LG03 — collect a booking's remaining balance by ITS OWN method (independent of the deposit).
// Mirrors the checkout picker (D1: only Efectivo + Transferencia for now); a transfer carries its
// bank reference and defers the QR to admin verification (US-A67). Defaults to the deposit's method.
//
// devolada-transfer-verification D8 — connected to Devolada, a transfer is collected by an enlace:
// the server records nothing yet, and the sheet shows the enlace instead of closing as settled. When
// no enlace could be created, the settlement WAS recorded on today's manual path (FR-010): the sheet
// closes as settled, and the alert saying why stays where the sheet is mounted.
export interface SettleSheetProps {
  open: boolean
  onClose: () => void
  folioId: string
  /** The amount this settle collects: the folio's balance — or one line's (US-AG54). */
  balance: number
  /** The deposit's method, used to pre-select the picker (never 'Mixto' for a live booking). */
  defaultMethod: PaymentMethod
  /** US-AG54 — set, the settle targets ONE line: its balance, its QR, its commission. */
  lineId?: string
  lineName?: string
}

export function SettleSheet({
  open,
  onClose,
  folioId,
  balance,
  defaultMethod,
  lineId,
  lineName,
}: SettleSheetProps) {
  const settle = useSettleBooking()
  const [method, setMethod] = useState<PaymentMethod>(defaultMethod)
  const [reference, setReference] = useState('')
  // FR-010 — the settlement that got no enlace, kept past the sheet's close so its alert can say why.
  const [unlinked, setUnlinked] = useState<{ error: PaymentLinkError; folio: Folio } | null>(null)

  // US-A88 — the org decides whether a transfer demands its reference. Optional still means
  // "4–64 chars if present": an empty field passes, a partial one doesn't.
  const { data: org } = useMyOrganization()
  const referenceRequired = org?.payment_reference_required ?? true
  // devolada-transfer-verification D8, FR-009 — mirrors settleBooking's and settleFolioLine's
  // `collectsByLink`: connected, the enlace collects the transfer, so it carries no reference. A
  // `broken` connection keeps today's rule; its seller sees the field (TransferPaymentFields).
  const collectsByLink = method === 'transfer' && org?.devolada?.status === 'connected'
  const referenceValid =
    method !== 'transfer' ||
    collectsByLink ||
    reference.trim().length >= 4 ||
    (!referenceRequired && reference.trim().length === 0)

  // D8 — the enlace this settle answered. Nothing was recorded: the sale is still an apartado, and
  // collecting is now «Cobrar por WhatsApp».
  const issued = settle.data?.payment_link ? settle.data : null
  // D8, D19 — the balance is already being collected by an open settlement enlace.
  const inProgress =
    settle.error instanceof ServiceError && settle.error.code === 'SETTLEMENT_IN_PROGRESS'

  // The mutation's answer belongs to this opening only: the next one starts at the form again.
  const close = () => {
    settle.reset()
    onClose()
  }

  // The message every enlace of the sale sends: its seller, the organization, and the expiry in the
  // organization's zone (PaymentLinkCard; contracts § The WhatsApp message for a link).
  const messageFor = (folio: Folio) => ({
    folio,
    agentName: folio.agent?.name ?? '',
    orgName: org?.name ?? 'Turistear Ya!',
    timezone: org?.timezone,
  })

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!referenceValid || settle.isPending || issued) return
    setUnlinked(null)
    settle.mutate(
      {
        id: folioId,
        lineId,
        payload: {
          method,
          // An empty optional reference is omitted, not sent as ''; so is any reference while an
          // enlace collects the transfer (FR-009).
          ...(method === 'transfer' && !collectsByLink && reference.trim()
            ? { payment_reference: reference.trim() }
            : {}),
        },
      },
      {
        onSuccess: (result) => {
          if (result.payment_link) return
          if (result.payment_link_error) {
            setUnlinked({ error: result.payment_link_error, folio: result.folio })
          }
          close()
        },
      },
    )
  }

  return (
    <>
      {/* FR-010 — the alert outlives the sheet, which closed as settled: the money now waits for an
          admin to verify it, and the seller is told why there was no enlace. */}
      {unlinked && (
        <PaymentLinkCard link={null} error={unlinked.error} message={messageFor(unlinked.folio)} />
      )}
      <FormSheet
        open={open}
        onClose={close}
        title={lineName ? `Liquidar ${lineName}` : 'Liquidar saldo'}
        // D8 — once the enlace exists, its card holds the sheet's one action; a submit would be a
        // second, competing exit (FormSheet's terminal state).
        submitLabel={issued ? undefined : 'Cobrar y liquidar'}
        onSubmit={onSubmit}
        busy={settle.isPending}
        disabled={!referenceValid}
        error={
          inProgress ? (
            <Alert severity="warning">{SETTLEMENT_IN_PROGRESS_COPY}</Alert>
          ) : settle.isError ? (
            <Alert severity="error">No se pudo liquidar el saldo. Inténtalo de nuevo.</Alert>
          ) : undefined
        }
      >
        {issued ? (
          <PaymentLinkCard link={issued.payment_link ?? null} message={messageFor(issued.folio)} />
        ) : (
          <Stack spacing={2}>
            <Stack spacing={0.25}>
              <Typography variant="body2" color="textSecondary">
                Saldo por cobrar
              </Typography>
              <MoneyText cents={balance} srLabel="Saldo por cobrar" />
            </Stack>

            <Stack spacing={0.75}>
              <Typography variant="body2" color="textSecondary">
                ¿Cómo se cobró el saldo?
              </Typography>
              {/* D1 — only Efectivo + Transferencia for now (card/link hidden), like checkout. */}
              <ToggleButtonGroup
                exclusive
                fullWidth
                value={method}
                onChange={(_, value) => value && setMethod(value as PaymentMethod)}
                aria-label="Método de pago del saldo"
              >
                <ToggleButton value="cash" aria-label="Efectivo">
                  <PaymentsRounded fontSize="small" sx={{ mr: 1 }} />
                  Efectivo
                </ToggleButton>
                <ToggleButton value="transfer" aria-label="Transferencia">
                  <AccountBalanceRounded fontSize="small" sx={{ mr: 1 }} />
                  Transferencia
                </ToggleButton>
              </ToggleButtonGroup>
            </Stack>

            {/* US-AG41 — a transfer carries its bank reference (optional per org, US-A88), and the
                QR is held until an admin verifies it; or, connected to Devolada, the enlace that
                replaces both (devolada-transfer-verification D16). */}
            {method === 'transfer' && (
              <TransferPaymentFields
                devolada={org?.devolada}
                referenceRequired={referenceRequired}
                reference={reference}
                onReferenceChange={setReference}
              />
            )}
          </Stack>
        )}
      </FormSheet>
    </>
  )
}
