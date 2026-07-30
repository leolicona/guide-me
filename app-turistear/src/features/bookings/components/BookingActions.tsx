import { useState } from 'react'
import { Alert, Box, Button, Skeleton, Stack, Typography } from '@mui/material'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import PaidRounded from '@mui/icons-material/PaidRounded'
import { useCancelBooking, useReactivateBooking } from '../hooks/useBookingActions'
import { SettleSheet } from './SettleSheet'
import { ConfirmSheet, MoneyText } from '../../../components'
import type { DisplayMethod, PaymentMethod } from '../../pos/types'
import type { PosCancellationQuote } from '../../../services/posService'

// Minimal shape the booking actions need — satisfied by both the agent (pos) folio detail and
// the admin folio detail, so the banner + buttons serve every detail surface (D5/D9).
export interface BookingFolio {
  id: string
  status: 'paid' | 'booking' | 'cancelled'
  booking_expires_at?: number | null
  /** US-LG03 — the settle sheet needs the balance + the deposit's method (to pre-select). */
  total?: number
  amount_paid?: number
  pending_balance?: number
  payment_method?: DisplayMethod
}

// What the ladder decided, read BEFORE confirming. Money reads first — the refund is the figure the
// agent may have to count out of their own drawer in the next thirty seconds, so it is the largest
// thing in the sheet.
//
// The forfeited commission is shown for the same reason and it is not a courtesy: under the engine's
// D19 an early cancellation zeroes the seller's commission, and the agent tapping the button is the
// person that lands on. Discovering it in a corte at the end of the shift is how a policy change
// turns into a grievance.
function CancellationOutcome({
  quote,
  loading,
}: {
  quote: PosCancellationQuote | null | undefined
  loading: boolean
}) {
  if (loading) return <Skeleton variant="rounded" height={72} />

  // The read failed, or the folio carries no quote. Cancelling is still allowed — the server
  // computes the real figure on confirm either way, and blocking a booth operation because a
  // read failed is worse than proceeding without the preview. Say so plainly rather than showing
  // a zero, which would read as "nothing is refunded".
  if (!quote) {
    return (
      <Alert severity="warning">
        No se pudo calcular el reembolso. Al confirmar se aplicará la política de cancelación de tu
        empresa.
      </Alert>
    )
  }

  return (
    <Box sx={{ border: 1, borderColor: 'grey.200', borderRadius: 2, p: 2 }}>
      <Stack
        direction="row"
        sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}
      >
        <Typography variant="body2" color="text.secondary">
          Se devuelve al cliente
        </Typography>
        <MoneyText
          cents={quote.refund}
          variant="h6"
          semantic="neutral"
          srLabel="Se devuelve al cliente"
        />
      </Stack>

      {quote.reversed_commission > 0 && (
        <Stack
          direction="row"
          sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1, mt: 1 }}
        >
          <Typography variant="body2" color="text.secondary">
            Comisión que pierdes
          </Typography>
          <MoneyText
            cents={quote.reversed_commission}
            variant="subtitle1"
            semantic="negative"
            srLabel="Comisión que pierdes"
          />
        </Stack>
      )}

      {quote.refund === 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Según la política de tu empresa, a esta distancia de la salida no corresponde reembolso.
        </Typography>
      )}
    </Box>
  )
}

// A live apartado (spots held, balance pending).
const isLiveBooking = (folio: BookingFolio) => folio.status === 'booking'

// A cancelled folio that still carries a booking expiry was an apartado that lapsed
// (US-AG07.5 late arrival) — distinct from an admin's total cancellation.
const isExpiredBooking = (folio: BookingFolio) =>
  folio.status === 'cancelled' && folio.booking_expires_at != null

// US-AG07.5 — the expiry banner, shown at the TOP of whichever folio-detail screen was opened.
// Integrated into the existing detail (no separate contingency screen).
export function ExpiredBookingBanner({ folio }: { folio: BookingFolio }) {
  if (!isExpiredBooking(folio)) return null
  return (
    <Alert severity="warning" icon={<EventBusyRounded />}>
      Apartado Expirado — Cupos Liberados. Reactívalo para volver a bloquear los lugares (si aún
      hay cupo) y cobrar el saldo.
    </Alert>
  )
}

// US-AG07 / US-AG07.4 / US-AG07.5 — the booking action buttons, dynamically incorporated into
// the existing folio detail: Liquidar/Cancelar for a live apartado, Reactivar for an expired
// one. Returns null for ordinary paid/cancelled folios so the detail reads normally.
export function BookingActions({
  folio,
  quote,
  quoteLoading = false,
}: {
  folio: BookingFolio
  /** What cancelling now would cost (US-A76). Passed in, not fetched: this component renders on
   *  three surfaces (POS receipt, POS history detail, admin folio detail) whose folio reads are
   *  different endpoints, and a presentational component that fetched would break that. */
  quote?: PosCancellationQuote | null
  quoteLoading?: boolean
}) {
  const cancel = useCancelBooking()
  const reactivate = useReactivateBooking()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [settleOpen, setSettleOpen] = useState(false)
  const busy = cancel.isPending || reactivate.isPending

  if (isLiveBooking(folio)) {
    // The amount this settle collects, and the deposit's method to pre-select the picker. A live
    // booking has a single collection, so its display method is a real method (never 'Mixto').
    const balance = folio.pending_balance ?? (folio.total ?? 0) - (folio.amount_paid ?? 0)
    const defaultMethod: PaymentMethod =
      folio.payment_method && folio.payment_method !== 'Mixto' ? folio.payment_method : 'cash'
    return (
      <>
        <Stack spacing={1.5}>
          <Button
            variant="contained"
            size="large"
            disableElevation
            startIcon={<PaidRounded />}
            disabled={busy}
            onClick={() => setSettleOpen(true)}
          >
            Liquidar saldo
          </Button>
          <Button color="inherit" disabled={busy} onClick={() => setConfirmOpen(true)}>
            Cancelar apartado
          </Button>
        </Stack>

        <SettleSheet
          open={settleOpen}
          onClose={() => setSettleOpen(false)}
          folioId={folio.id}
          balance={balance}
          defaultMethod={defaultMethod}
        />

        {/* US-AG07.4 / US-A76 — the confirm no longer ASSERTS what happens to the money, it states
            what the ladder decided. It used to read "el anticipo ya cobrado no es reembolsable",
            which was true only while a deposit clause overrode every tier; with that clause deleted
            the same apartado can refund in full. An agent about to hand back cash has to see the
            figure before tapping, not after. */}
        <ConfirmSheet
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="¿Cancelar el apartado?"
          description="Se liberarán los lugares reservados para que vuelvan a estar disponibles."
          detail={<CancellationOutcome quote={quote} loading={quoteLoading} />}
          confirmLabel="Cancelar apartado"
          cancelLabel="Conservar"
          busy={cancel.isPending}
          onConfirm={() => cancel.mutate({ id: folio.id })}
          error={
            cancel.isError ? (
              <Alert severity="error">No se pudo cancelar el apartado. Inténtalo de nuevo.</Alert>
            ) : null
          }
        />
      </>
    )
  }

  if (isExpiredBooking(folio)) {
    return (
      <Stack spacing={1.5}>
        <Button
          variant="contained"
          size="large"
          disableElevation
          disabled={busy}
          onClick={() => reactivate.mutate(folio.id)}
        >
          {reactivate.isPending ? 'Reactivando…' : 'Reactivar y Liquidar'}
        </Button>
        {reactivate.isError && (
          <Alert severity="error">
            El tour ya no tiene cupo para reactivar este apartado.
          </Alert>
        )}
        <Stack direction="row" spacing={1.5}>
          <Button fullWidth disabled>
            Reagendar (Próximamente)
          </Button>
          <Button fullWidth disabled>
            Generar cupón (Próximamente)
          </Button>
        </Stack>
      </Stack>
    )
  }

  return null
}
