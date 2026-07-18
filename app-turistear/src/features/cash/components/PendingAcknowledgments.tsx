import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
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
import { AlertCard, MoneyText } from '../../../components'

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
    <Box>
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

      {/* Each obligation is its own top-of-screen alert that blocks attention until resolved —
          the money reads first, the Firmar/Disputar actions sit in the card footer. */}
      <Stack spacing={2}>
        {items.map((item) => {
          const adjusted = item.amount_requested != null
          const countdown = ackCountdown(item.ack_due_at)
          const source =
            item.source === 'admin' ? 'Cobro directo del administrador' : 'Ajuste en tu entrega'
          return (
            <AlertCard
              key={item.id}
              tone="warning"
              title={
                <>
                  <Typography variant="overline" sx={{ display: 'block', opacity: 0.85 }}>
                    {source}
                  </Typography>
                  <MoneyText cents={item.amount} variant="h3" srLabel={source} />
                </>
              }
              actions={
                <>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={() => acknowledge.mutate(item.id)}
                    disabled={acknowledge.isPending || dispute.isPending}
                  >
                    {/* Verb glossary (US-UX05): the agent's acknowledgment is "Firmar" —
                        "Confirmar" is reserved for the ADMIN accepting a drop/collection. */}
                    Firmar
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
                </>
              }
            >
              {adjusted && (
                <Box component="span" sx={{ display: 'block' }}>
                  Reportaste {formatMoney(item.amount_requested as number)} · registrado{' '}
                  {formatMoney(item.amount)}
                </Box>
              )}
              {item.note && (
                <Box component="span" sx={{ display: 'block' }}>
                  {item.note}
                </Box>
              )}
              {countdown && (
                <Box component="span" sx={{ display: 'block', mt: 0.5, opacity: 0.85 }}>
                  {countdown}
                </Box>
              )}
            </AlertCard>
          )
        })}
      </Stack>

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
    </Box>
  )
}
