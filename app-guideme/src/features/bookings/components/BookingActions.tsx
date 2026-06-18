import { useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
} from '@mui/material'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import PaidRounded from '@mui/icons-material/PaidRounded'
import { useSettleBooking, useCancelBooking, useReactivateBooking } from '../hooks/useBookingActions'

// Minimal shape the booking actions need — satisfied by both the agent (pos) folio detail and
// the admin folio detail, so the banner + buttons serve every detail surface (D5/D9).
export interface BookingFolio {
  id: string
  status: 'paid' | 'booking' | 'cancelled'
  booking_expires_at?: number | null
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
export function BookingActions({ folio }: { folio: BookingFolio }) {
  const settle = useSettleBooking()
  const cancel = useCancelBooking()
  const reactivate = useReactivateBooking()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const busy = settle.isPending || cancel.isPending || reactivate.isPending

  if (isLiveBooking(folio)) {
    return (
      <>
        <Stack spacing={1.5}>
          <Button
            variant="contained"
            size="large"
            disableElevation
            startIcon={<PaidRounded />}
            disabled={busy}
            onClick={() => settle.mutate(folio.id)}
          >
            {settle.isPending ? 'Liquidando…' : 'Liquidar saldo'}
          </Button>
          <Button color="inherit" disabled={busy} onClick={() => setConfirmOpen(true)}>
            Cancelar apartado
          </Button>
        </Stack>

        {/* US-AG07.4 — confirm cancel in an in-app dialog (no native window.confirm). */}
        <Dialog
          open={confirmOpen}
          onClose={() => !cancel.isPending && setConfirmOpen(false)}
          maxWidth="xs"
          fullWidth
        >
          <DialogTitle>¿Cancelar el apartado?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              Se liberarán los lugares reservados para que vuelvan a estar disponibles. El
              anticipo ya cobrado <strong>no es reembolsable</strong>.
            </DialogContentText>
            {cancel.isError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                No se pudo cancelar el apartado. Inténtalo de nuevo.
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmOpen(false)} disabled={cancel.isPending}>
              Conservar
            </Button>
            <Button
              variant="contained"
              color="error"
              disableElevation
              onClick={() => cancel.mutate({ id: folio.id })}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? 'Cancelando…' : 'Cancelar apartado'}
            </Button>
          </DialogActions>
        </Dialog>
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
