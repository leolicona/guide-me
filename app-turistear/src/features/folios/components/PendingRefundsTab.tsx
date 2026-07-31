import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/material'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import { usePendingRefunds } from '../hooks'
import { QueueRow } from './QueueRow'
import { useNowSeconds } from '../hooks/useNowSeconds'

// US-A78 (docs/oversight/pending-work-queues.spec.md) — cash the company still owes customers.
//
// `refund_status = 'pending'` has existed since US-A23 and nothing has ever listed it. That gap
// matters more than it looks: the negative ledger row is written at CANCELLATION, so the agent's
// balance already dropped, while confirming the PIN only flips a flag. Until someone confirms,
// the books say the money was handed back and only the customer knows whether it was.
//
// READ-ONLY by design (spec Q6). Confirming needs the customer's PIN, which needs the customer
// present — that action stays on the folio detail. A money action one tap from a list is how the
// wrong folio gets confirmed.

export function PendingRefundsTab() {
  const { data: folios, isLoading, isError } = usePendingRefunds()
  const now = useNowSeconds()

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (isError) {
    return <Alert severity="error">No se pudieron cargar los reembolsos pendientes.</Alert>
  }

  if (!folios?.length) {
    return (
      <Stack spacing={1.5} sx={{ alignItems: 'center', py: 6, textAlign: 'center' }}>
        <PaymentsRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          No hay reembolsos pendientes
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 380 }}>
          Todo el dinero cancelado ya fue entregado y confirmado con el PIN del cliente.
        </Typography>
      </Stack>
    )
  }


  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Dinero que la empresa debe devolver. Se confirma con el PIN del cliente, en el detalle del
        folio.
      </Typography>

      {/* Server-ordered oldest first (spec Q5) — do NOT re-sort here. */}
      {folios.map((f) => (
        <QueueRow
          key={f.id}
          folioId={f.id}
          customerName={f.customer_name}
          agentName={f.agent.name}
          amountCents={f.refund_amount ?? 0}
          amountLabel="Reembolso pendiente"
          ageSeconds={now === null || f.cancelled_at == null ? null : now - f.cancelled_at}
          ageLabel="cancelado"
        />
      ))}
    </Stack>
  )
}
