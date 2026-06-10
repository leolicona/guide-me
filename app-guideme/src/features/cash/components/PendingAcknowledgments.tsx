import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useAcknowledgeDrop, useDisputeDrop } from '../hooks'
import type { PendingAck } from '../types'
import { formatMoney } from '../../catalog/types'
import { ackCountdown } from './ackPresentation'

// US-AG27/AG28 — the agent's outstanding signature obligations, rendered as a NON-BLOCKING
// inline card list (never a modal: it must not interrupt a sale or the balance view). Each
// item is an admin money-move that already took effect; signing is an audit agreement, and
// disputing flags it back to the admin with a required reason. Unsigned items auto-sign once
// the org's window elapses (the countdown line).
export function PendingAcknowledgments({ items }: { items: PendingAck[] }) {
  const acknowledge = useAcknowledgeDrop()
  const dispute = useDisputeDrop()
  const [disputeTarget, setDisputeTarget] = useState<PendingAck | null>(null)
  const [reason, setReason] = useState('')

  if (items.length === 0) return null

  const submitDispute = () => {
    if (!disputeTarget || !reason.trim()) return
    dispute.mutate(
      { id: disputeTarget.id, input: { note: reason.trim() } },
      {
        onSuccess: () => {
          setDisputeTarget(null)
          setReason('')
        },
      },
    )
  }

  return (
    <Card variant="outlined" sx={{ borderColor: 'warning.main' }}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 0.5 }}>
          Pendientes de firma
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          El administrador registró estos movimientos en tu saldo. Revísalos y firma de
          conformidad, o levanta una disputa si no estás de acuerdo.
        </Typography>

        {(acknowledge.isError || dispute.isError) && (
          <Alert severity="error" sx={{ mb: 2 }}>
            No se pudo enviar tu respuesta. Inténtalo de nuevo.
          </Alert>
        )}

        <Stack spacing={2}>
          {items.map((item) => {
            const adjusted = item.amount_requested != null
            const countdown = ackCountdown(item.ack_due_at)
            return (
              <Box
                key={item.id}
                sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}
              >
                <Typography variant="overline" color="text.secondary">
                  {item.source === 'admin' ? 'Cobro directo del administrador' : 'Ajuste en tu entrega'}
                </Typography>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  {formatMoney(item.amount)}
                </Typography>
                {adjusted && (
                  <Typography variant="body2" color="text.secondary">
                    Reportaste {formatMoney(item.amount_requested as number)} · registrado{' '}
                    {formatMoney(item.amount)}
                  </Typography>
                )}
                {item.note && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    {item.note}
                  </Typography>
                )}
                {countdown && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    {countdown}
                  </Typography>
                )}
                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  <Button
                    variant="contained"
                    size="small"
                    disableElevation
                    onClick={() => acknowledge.mutate(item.id)}
                    disabled={acknowledge.isPending || dispute.isPending}
                  >
                    Firmar / Confirmar
                  </Button>
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() => {
                      setReason('')
                      setDisputeTarget(item)
                    }}
                    disabled={acknowledge.isPending || dispute.isPending}
                  >
                    Disputar
                  </Button>
                </Stack>
              </Box>
            )
          })}
        </Stack>
      </CardContent>

      <Dialog
        open={!!disputeTarget}
        onClose={() => setDisputeTarget(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Disputar movimiento</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Tu saldo no cambia con la disputa — el administrador la revisará y, si procede,
            registrará la corrección. Explica por qué no estás de acuerdo.
          </Typography>
          <TextField
            label="Razón"
            fullWidth
            multiline
            minRows={2}
            autoFocus
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {dispute.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              No se pudo registrar la disputa. Inténtalo de nuevo.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDisputeTarget(null)}>Cancelar</Button>
          <Button
            variant="contained"
            color="error"
            disableElevation
            onClick={submitDispute}
            disabled={dispute.isPending || !reason.trim()}
          >
            {dispute.isPending ? 'Enviando…' : 'Disputar'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  )
}
