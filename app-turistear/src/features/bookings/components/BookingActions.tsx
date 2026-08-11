import { useState } from 'react'
import { Alert, Box, Button, Skeleton, Stack, Typography } from '@mui/material'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import PaidRounded from '@mui/icons-material/PaidRounded'
import { useCancelBooking } from '../hooks/useBookingActions'
import { SettleSheet } from './SettleSheet'
import { RescheduleSheet } from './RescheduleSheet'
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
  /** D16 — while a transfer awaits verification there is no ticket yet, so nothing to warn about. */
  payment_verification?: string
  /** US-AG52 — the lines the reschedule sheet offers to move (tour lines only). */
  lines?: {
    id?: string
    service_id?: string
    slot_id?: string | null
    service_name: string
    slot_date: string | null
    slot_start_time: string | null
    quantity?: number
    line_type?: 'slot' | 'stay'
    /** D19 — a line with redeemed passes was consumed and cannot move. */
    redeemed_count?: number
    /** US-AG54 — the line's OWN money state, balance and hold clock (server-derived). */
    money_state?: 'paid' | 'booking' | 'cancelled'
    pending_balance?: number
    booking_expires_at?: number | null
    cancelled_at?: number | null
  }[]
}

// US-AG54 — a line's own deadline, in the words a seller uses at the counter. Coarse on purpose:
// the exact instant lives in the sheet's server response; this is the glance.
const lineDeadline = (expiresAt: number | null | undefined): string | null => {
  if (!expiresAt) return null
  const hours = Math.floor((expiresAt * 1000 - Date.now()) / 3_600_000)
  if (hours < 0) return 'vencido'
  if (hours < 1) return 'vence en menos de 1 h'
  if (hours < 48) return `vence en ${hours} h`
  return `vence en ${Math.floor(hours / 24)} días`
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
  // US-AG54 — the line being settled / cancelled alone (null = whole-folio gestures).
  const [settleLine, setSettleLine] = useState<{ id: string; name: string; balance: number } | null>(null)
  const [cancelLine, setCancelLine] = useState<{ id: string; name: string } | null>(null)

  // D11 — same service only. A stay is nights under a per-night guard rather than a slot, and is
  // deferred with its own scenarios. The sheet fetches the SELECTED line's calendar itself — the
  // options used to come from the FIRST line's service, which offered a two-service folio the
  // wrong calendar for every line but one.
  const rescheduleLines = (folio.lines ?? [])
    .filter((l) => l.line_type !== 'stay' && !!l.id && !!l.service_id)
    .map((l) => ({
      id: l.id!,
      service_id: l.service_id!,
      slot_id: l.slot_id ?? null,
      service_name: l.service_name,
      slot_date: l.slot_date,
      slot_start_time: l.slot_start_time,
      quantity: l.quantity ?? 1,
    }))
  const busy = cancel.isPending

  if (isLiveBooking(folio)) {
    // US-AG54 — the lines still holding a balance, each with its own clock. When more than one
    // lives, the per-line gesture appears and the main button becomes "Liquidar todo"; a folio
    // read by an older shape (no money_state) simply keeps the single button.
    const apartadaLines = (folio.lines ?? []).filter(
      (l) => l.id && l.money_state === 'booking' && (l.pending_balance ?? 0) > 0,
    )
    // The amount the whole-folio settle collects: Σ of the live lines' own balances when the
    // server sent them (a cancelled line's remainder must never be charged — F3), else the
    // scalar arithmetic it always was.
    const balance =
      apartadaLines.length > 0
        ? apartadaLines.reduce((s, l) => s + (l.pending_balance ?? 0), 0)
        : (folio.pending_balance ?? (folio.total ?? 0) - (folio.amount_paid ?? 0))
    const defaultMethod: PaymentMethod =
      folio.payment_method && folio.payment_method !== 'Mixto' ? folio.payment_method : 'cash'
    const multiLine = apartadaLines.length > 1
    return (
      <>
        <Stack spacing={1.5}>
          {/* US-AG54 — one row per line still owing: its balance, its deadline, its verbs. The
              whole-folio buttons keep the common case at one tap below. */}
          {multiLine &&
            apartadaLines.map((line) => (
              <Box
                key={line.id}
                sx={{ border: 1, borderColor: 'grey.200', borderRadius: 2, p: 1.5 }}
              >
                <Stack
                  direction="row"
                  sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" noWrap>
                      {line.service_name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {line.slot_date ?? ''}
                      {lineDeadline(line.booking_expires_at)
                        ? ` · ${lineDeadline(line.booking_expires_at)}`
                        : ''}
                    </Typography>
                  </Box>
                  <MoneyText
                    cents={line.pending_balance ?? 0}
                    variant="subtitle1"
                    semantic="neutral"
                    srLabel={`Saldo de ${line.service_name}`}
                  />
                </Stack>
                <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={busy}
                    onClick={() =>
                      setSettleLine({
                        id: line.id!,
                        name: line.service_name,
                        balance: line.pending_balance ?? 0,
                      })
                    }
                  >
                    Liquidar
                  </Button>
                  {folio.payment_verification !== 'pending' && (
                    <Button
                      size="small"
                      color="error"
                      disabled={busy}
                      onClick={() => setCancelLine({ id: line.id!, name: line.service_name })}
                    >
                      Cancelar
                    </Button>
                  )}
                </Stack>
              </Box>
            ))}
          <Button
            variant="contained"
            size="large"
            disableElevation
            startIcon={<PaidRounded />}
            disabled={busy}
            onClick={() => setSettleOpen(true)}
          >
            {multiLine ? 'Liquidar todo' : 'Liquidar saldo'}
          </Button>
          {/* US-AG52 — the cheap operation, and the one the product never had. Here the seats are
              still the customer's: moving a hold you own takes nothing from anybody, and no money
              is re-decided. It sits ABOVE Cancelar because cancelling prices the customer and this
              does not — the destructive verb should never be the easier one to reach. */}
          <Button
            variant="outlined"
            color="inherit"
            size="large"
            startIcon={<EventRepeatRounded />}
            disabled={busy}
            onClick={() => setRescheduleOpen(true)}
          >
            Reagendar
          </Button>
          {/* BUG-030 — an unverified transfer deposit parks the cancel: the ladder would price
              money the company never confirmed and mint a refund PIN for it. `Rechazar pago`
              (the work card) is the cancel path for unconfirmed money. */}
          {folio.payment_verification !== 'pending' && (
            <Button
              variant="outlined"
              color="error"
              size="large"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
            >
              Cancelar apartado
            </Button>
          )}
        </Stack>

        <RescheduleSheet
          open={rescheduleOpen}
          onClose={() => setRescheduleOpen(false)}
          folioId={folio.id}
          lines={rescheduleLines}
          isPaid={false}
        />

        <SettleSheet
          open={settleOpen}
          onClose={() => setSettleOpen(false)}
          folioId={folio.id}
          balance={balance}
          defaultMethod={defaultMethod}
        />

        {/* US-AG54 — settle ONE line: its balance, its QR, its commission. */}
        <SettleSheet
          open={!!settleLine}
          onClose={() => setSettleLine(null)}
          folioId={folio.id}
          balance={settleLine?.balance ?? 0}
          defaultMethod={defaultMethod}
          lineId={settleLine?.id}
          lineName={settleLine?.name}
        />

        {/* US-AG54 — cancel ONE apartada line. The figure shown is the SUBSET quote the server
            computed (line_refund); the sibling lines are untouched by construction. */}
        <ConfirmSheet
          open={!!cancelLine}
          onClose={() => setCancelLine(null)}
          title={`¿Cancelar ${cancelLine?.name ?? 'esta actividad'}?`}
          description="Se liberan solo los lugares de esta actividad; el resto del apartado sigue vivo, con su propio plazo."
          detail={(() => {
            const lineQuote = quote?.lines?.find((l) => l.line_id === cancelLine?.id)
            if (!lineQuote || lineQuote.line_refund == null) {
              return <CancellationOutcome quote={null} loading={quoteLoading} />
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
                    cents={lineQuote.line_refund}
                    variant="h6"
                    semantic="neutral"
                    srLabel="Se devuelve al cliente"
                  />
                </Stack>
                {(lineQuote.line_reversed_commission ?? 0) > 0 && (
                  <Stack
                    direction="row"
                    sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1, mt: 1 }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      Comisión que pierdes
                    </Typography>
                    <MoneyText
                      cents={lineQuote.line_reversed_commission ?? 0}
                      variant="subtitle1"
                      semantic="negative"
                      srLabel="Comisión que pierdes"
                    />
                  </Stack>
                )}
              </Box>
            )
          })()}
          confirmLabel="Cancelar actividad"
          cancelLabel="Conservar"
          busy={cancel.isPending}
          onConfirm={() =>
            cancelLine &&
            cancel.mutate({ id: folio.id, lineId: cancelLine.id }, { onSuccess: () => setCancelLine(null) })
          }
          error={
            cancel.isError ? (
              <Alert severity="error">No se pudo cancelar la actividad. Inténtalo de nuevo.</Alert>
            ) : null
          }
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

  // D16 — a PAID folio reschedules too: the customer who cannot make Friday has exactly the same
  // need, and before this their only option was cancelling, which runs the ladder against them.
  // The sheet warns that the current ticket dies and a new one is sent — unless the transfer is
  // still awaiting verification, in which case no ticket exists yet and there is nothing to kill.
  //
  // D19 — the door is per line and closes at departure: a departed line reads no-show and does not
  // move (the courtesy is a discount on a NEW sale), and a line with redeemed passes was consumed.
  // Client-clock date compare is a pre-filter only; the server holds the real guard.
  const todayIso = new Date().toISOString().slice(0, 10)
  const movablePaidLines = rescheduleLines.filter((l) => {
    const src = folio.lines?.find((f) => f.id === l.id)
    if ((src?.redeemed_count ?? 0) > 0) return false
    return !l.slot_date || l.slot_date >= todayIso
  })
  if (folio.status === 'paid' && movablePaidLines.length > 0) {
    return (
      <>
        <Stack spacing={1.5}>
          <Button
            variant="outlined"
            color="inherit"
            size="large"
            startIcon={<EventRepeatRounded />}
            onClick={() => setRescheduleOpen(true)}
          >
            Reagendar
          </Button>
        </Stack>
        <RescheduleSheet
          open={rescheduleOpen}
          onClose={() => setRescheduleOpen(false)}
          folioId={folio.id}
          lines={movablePaidLines}
          isPaid={folio.payment_verification !== 'pending'}
        />
      </>
    )
  }

  // US-AG07.5 RETIRED (booking-reschedule.spec.md D3). This branch offered `Reactivar y Liquidar`,
  // which resurrected a folio the system had cancelled and told the customer it had cancelled — and
  // two buttons marked "Próximamente" that never arrived. Reagendar now lives on a LIVE apartado
  // and on a PAID folio (above), where the seats are still the customer's and moving them takes
  // nothing from anybody.
  //
  // A customer arriving after the hold ended makes an ordinary sale; the banner says so, and the
  // credit is on the folio for the seller to apply.

  return null
}
