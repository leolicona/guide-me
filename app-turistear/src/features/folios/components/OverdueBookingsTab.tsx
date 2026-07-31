import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/material'
import HourglassBottomRounded from '@mui/icons-material/HourglassBottomRounded'
import { useOverdueBookings } from '../hooks'
import { QueueRow } from './QueueRow'
import { useNowSeconds } from '../hooks/useNowSeconds'

// US-A79 (docs/oversight/pending-work-queues.spec.md) — apartados past their settle deadline.
//
// Since the apartado-stages redesign the deadline no longer cancels: the folio advances to a
// grace stage and waits. That is the right behaviour, and it means a hold can sit for days on
// seats with money still owed, visible only as one `booking` among every other `booking`.
//
// "Overdue" is DERIVED server-side from `booking_expires_at`, never stored (apartado-stages S7):
// a stored stage needs a writer, and a cron that writes state drifts from the clock that defines
// it. A WHERE clause cannot drift.

export function OverdueBookingsTab() {
  const { data: folios, isLoading, isError } = useOverdueBookings()
  const now = useNowSeconds()

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (isError) {
    return <Alert severity="error">No se pudieron cargar los apartados vencidos.</Alert>
  }

  if (!folios?.length) {
    return (
      <Stack spacing={1.5} sx={{ alignItems: 'center', py: 6, textAlign: 'center' }}>
        <HourglassBottomRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          No hay apartados vencidos
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 380 }}>
          Todos los apartados están dentro de su plazo o ya fueron liquidados.
        </Typography>
      </Stack>
    )
  }


  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Apartados que pasaron su fecha límite y siguen sin liquidar. Conservan sus lugares hasta
        poco antes de la salida.
      </Typography>

      {/* Server-ordered most-overdue first — do NOT re-sort here. */}
      {folios.map((f) => (
        <QueueRow
          key={f.id}
          folioId={f.id}
          customerName={f.customer_name}
          agentName={f.agent.name}
          amountCents={f.pending_balance ?? f.total - f.amount_paid}
          amountLabel="Saldo por cobrar"
          ageSeconds={now === null || f.booking_expires_at == null ? null : now - f.booking_expires_at}
          ageLabel="venció"
        />
      ))}
    </Stack>
  )
}
