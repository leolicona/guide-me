import { useState } from 'react'
import { Alert, Box, Button, Skeleton, Stack, Typography } from '@mui/material'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import PaidRounded from '@mui/icons-material/PaidRounded'
import { useCancelBooking } from '../hooks/useBookingActions'
import { SettleSheet } from './SettleSheet'
import { RescheduleSheet } from './RescheduleSheet'
import { usePosService } from '../../pos/hooks/usePosService'
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded'
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
  /** US-AG52 — the lines the reschedule sheet offers to move (tour lines only). */
  lines?: {
    id?: string
    service_id?: string
    service_name: string
    slot_date: string | null
    slot_start_time: string | null
    line_type?: 'slot' | 'stay'
  }[]
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
      Apartado vencido — los lugares se liberaron. Si el cliente llega, es una venta nueva: aplica
      su saldo a favor si lo tiene.
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
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [settleOpen, setSettleOpen] = useState(false)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)

  // D11 — same service only, so the options come from THE line's service. A stay is nights under a
  // per-night guard rather than a slot, and is deferred with its own scenarios.
  const rescheduleLines = (folio.lines ?? [])
    .filter((l) => l.line_type !== 'stay' && !!l.id)
    .map((l) => ({
      id: l.id!,
      service_name: l.service_name,
      slot_date: l.slot_date,
      slot_start_time: l.slot_start_time,
    }))
  const firstServiceId = folio.lines?.find((l) => l.line_type !== 'stay')?.service_id
  // Only asked for while the sheet is open: a folio detail should not fetch a service's calendar
  // for a button nobody pressed.
  const service = usePosService(rescheduleOpen ? firstServiceId : undefined)
  const rescheduleOptions = (service.data?.slots ?? [])
    .filter((s) => s.remaining > 0)
    .map((s) => ({ id: s.id, date: s.date, start_time: s.start_time, remaining: s.remaining }))
  const busy = cancel.isPending

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
          {/* US-AG52 — the cheap operation, and the one the product never had. Here the seats are
              still the customer's: moving a hold you own takes nothing from anybody, and no money
              is re-decided. It sits ABOVE Cancelar because cancelling prices the customer and this
              does not — the destructive verb should never be the easier one to reach. */}
          <Button
            color="inherit"
            startIcon={<EventRepeatRounded />}
            disabled={busy}
            onClick={() => setRescheduleOpen(true)}
          >
            Reagendar
          </Button>
          <Button color="inherit" disabled={busy} onClick={() => setConfirmOpen(true)}>
            Cancelar apartado
          </Button>
        </Stack>

        <RescheduleSheet
          open={rescheduleOpen}
          onClose={() => setRescheduleOpen(false)}
          folioId={folio.id}
          lines={rescheduleLines}
          options={rescheduleOptions}
          isPaid={folio.status === 'paid'}
        />

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

  // US-AG07.5 RETIRED (booking-reschedule.spec.md D3). This branch offered `Reactivar y Liquidar`,
  // which resurrected a folio the system had cancelled and told the customer it had cancelled — and
  // two buttons marked "Próximamente" that never arrived. Reagendar now lives on a LIVE apartado
  // (above), where the seats are still the customer's and moving them takes nothing from anybody.
  //
  // A customer arriving after the hold ended makes an ordinary sale; the banner says so, and the
  // credit is on the folio for the seller to apply.

  return null
}
