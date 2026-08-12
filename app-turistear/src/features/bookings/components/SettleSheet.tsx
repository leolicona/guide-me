import { useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import { FormSheet } from '../../../components/FormSheet'
import { MoneyText } from '../../../components/MoneyText'
import { useMyOrganization } from '../../organization'
import type { PaymentMethod } from '../../pos/types'
import { useSettleBooking } from '../hooks/useBookingActions'

// US-LG03 — collect a booking's remaining balance by ITS OWN method (independent of the deposit).
// Mirrors the checkout picker (D1: only Efectivo + Transferencia for now); a transfer carries its
// bank reference and defers the QR to admin verification (US-A67). Defaults to the deposit's method.
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

  // US-A88 — the org decides whether a transfer demands its reference. Optional still means
  // "4–64 chars if present": an empty field passes, a partial one doesn't.
  const { data: org } = useMyOrganization()
  const referenceRequired = org?.payment_reference_required ?? true
  const referenceValid =
    method !== 'transfer' ||
    reference.trim().length >= 4 ||
    (!referenceRequired && reference.trim().length === 0)

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!referenceValid || settle.isPending) return
    settle.mutate(
      {
        id: folioId,
        lineId,
        payload: {
          method,
          // An empty optional reference is omitted, not sent as ''.
          ...(method === 'transfer' && reference.trim()
            ? { payment_reference: reference.trim() }
            : {}),
        },
      },
      { onSuccess: onClose },
    )
  }

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title={lineName ? `Liquidar ${lineName}` : 'Liquidar saldo'}
      submitLabel="Cobrar y liquidar"
      onSubmit={onSubmit}
      busy={settle.isPending}
      disabled={!referenceValid}
      error={
        settle.isError ? (
          <Alert severity="error">No se pudo liquidar el saldo. Inténtalo de nuevo.</Alert>
        ) : undefined
      }
    >
      <Stack spacing={2}>
        <Stack spacing={0.25}>
          <Typography variant="body2" color="text.secondary">
            Saldo por cobrar
          </Typography>
          <MoneyText cents={balance} srLabel="Saldo por cobrar" />
        </Stack>

        <Stack spacing={0.75}>
          <Typography variant="body2" color="text.secondary">
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

        {/* US-AG41 — a transfer carries its bank reference (optional per org, US-A88); the QR is
            held until an admin verifies either way. */}
        {method === 'transfer' && (
          <TextField
            label={
              referenceRequired
                ? 'Referencia de la transferencia'
                : 'Referencia de la transferencia (opcional)'
            }
            placeholder="Ej. BBVA 0099887766"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            error={reference.trim().length > 0 && !referenceValid}
            helperText={
              reference.trim().length > 0 && !referenceValid
                ? 'Captura al menos 4 caracteres.'
                : 'Número o folio del comprobante — el administrador lo verifica.'
            }
            fullWidth
          />
        )}
      </Stack>
    </FormSheet>
  )
}
