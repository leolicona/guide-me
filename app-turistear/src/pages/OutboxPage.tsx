import { useState } from 'react'
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded'
import { SectionCard } from '../components'
import {
  useMarkNotificationSent,
  useOutbox,
  type OutboxRow,
} from '../features/folios/hooks/useOutbox'

// US-A86 — the admin's outbox.
// Spec: docs/folios/folio-state-machine.spec.md.
//
// Only ONE of the two kinds of notification is really a queue (D12). An action-tail leaves with the
// tap that produced it and can never accumulate; what lands here is the clock-produced half, plus
// anything a provider refused. Six of the eight events never appear as work — which is the point,
// and why this screen is short.
//
// The seller has no equivalent (D13): US-AG50 gave them the card, not the admin's work queue.

const EVENT_LABEL: Record<string, string> = {
  booking_created: 'Apartado creado',
  tickets_delivered: 'Boletos',
  payment_verified: 'Pago verificado',
  cancellation_approved: 'Cancelación aprobada',
  payment_rejected: 'Pago rechazado',
  booking_grace_entered: 'Apartado por vencer',
  departure_reminder: 'Recordatorio de salida',
  refund_completed: 'Recibo de reembolso',
}

/** Fills the template with what this row knows. Anything unresolved is dropped, never shown raw. */
const composerText = (row: OutboxRow): string =>
  (row.template ?? '')
    .replace(/\{customer_name\}/g, row.customer_name ?? '')
    .replace(/\{[a-z_]+\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()

function OutboxItem({ row }: { row: OutboxRow }) {
  const mark = useMarkNotificationSent()

  const send = () => {
    const digits = (row.customer_phone ?? '').replace(/\D/g, '')
    if (digits) {
      window.open(
        `https://wa.me/${digits}?text=${encodeURIComponent(composerText(row))}`,
        '_blank',
      )
    }
    // The tap is what makes it `sent` — a Worker cannot send WhatsApp, so a human confirming is the
    // only record there is (D21). It says someone sent it, never that the customer read it.
    mark.mutate(row.id)
  }

  return (
    <SectionCard>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {row.customer_name ?? 'Cliente sin nombre'}
          </Typography>
          <Chip size="small" label={EVENT_LABEL[row.event] ?? row.event} />
          {row.status === 'failed' && (
            <Chip
              size="small"
              color="error"
              variant="outlined"
              icon={<ErrorOutlineRounded />}
              label={`Falló ${row.attempts}×`}
            />
          )}
        </Stack>

        <Typography variant="body2" color="text.secondary">
          {composerText(row)}
        </Typography>

        {row.status === 'failed' && row.last_error && (
          <Typography variant="caption" color="error.main">
            {row.last_error}
          </Typography>
        )}

        {row.channel === 'whatsapp' ? (
          <Button
            variant="contained"
            disableElevation
            startIcon={<WhatsAppIcon />}
            disabled={mark.isPending || !row.customer_phone}
            onClick={send}
          >
            {mark.isPending ? 'Marcando…' : 'Enviar por WhatsApp'}
          </Button>
        ) : (
          // An email row drains itself; a human marking one sent would be asserting something they
          // did not do (D21). Stated rather than silently rendering a dead button.
          <Typography variant="caption" color="text.secondary">
            Este correo se envía solo.
          </Typography>
        )}
      </Stack>
    </SectionCard>
  )
}

export default function OutboxPage() {
  const [channel] = useState<'whatsapp' | undefined>('whatsapp')
  const pending = useOutbox({ status: 'pending', channel })
  const failed = useOutbox({ status: 'failed' })

  const rows = [...(failed.data ?? []), ...(pending.data ?? [])]

  return (
    <Box sx={{ p: 3, maxWidth: 720, mx: 'auto' }}>
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5 }}>
        Mensajes por enviar
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Lo que el reloj generó y nadie ha mandado todavía. Los mensajes que salen de una acción —
        verificar un pago, confirmar un reembolso — se envían solos con esa acción y nunca llegan
        aquí.
      </Typography>

      {(pending.isError || failed.isError) && (
        <Alert severity="error" sx={{ mb: 2 }}>
          No se pudo leer la bandeja. Inténtalo de nuevo.
        </Alert>
      )}

      {!pending.isLoading && rows.length === 0 && (
        <SectionCard>
          <Typography color="text.secondary">
            Nada pendiente. Cada mensaje salió con la acción que lo produjo.
          </Typography>
        </SectionCard>
      )}

      <Stack spacing={2}>
        {rows.map((row) => (
          <OutboxItem key={row.id} row={row} />
        ))}
      </Stack>
    </Box>
  )
}
