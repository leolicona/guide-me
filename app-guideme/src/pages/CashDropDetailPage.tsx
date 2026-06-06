import { useState } from 'react'
import { useParams, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Divider,
  Chip,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import { useDrop, useReviewDrop } from '../features/cash/hooks'
import type { DropStatus } from '../features/cash/types'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

const DROP_COLOR: Record<DropStatus, 'warning' | 'success' | 'error'> = {
  pending: 'warning',
  confirmed: 'success',
  rejected: 'error',
}

const DROP_LABEL: Record<DropStatus, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmado',
  rejected: 'Rechazado',
}

const formatDate = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

export default function CashDropDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: drop, isLoading, isError } = useDrop(id)
  const review = useReviewDrop()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [note, setNote] = useState('')

  const isPending = drop?.status === 'pending'

  const confirm = () => {
    if (!id) return
    review.mutate({ id, input: { decision: 'confirmed' } })
  }

  const reject = () => {
    if (!id) return
    review.mutate(
      { id, input: { decision: 'rejected', note: note.trim() || null } },
      { onSuccess: () => setRejectOpen(false) },
    )
  }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 560, mx: 'auto' }}>
        <Button component={RouterLink} to={ROUTES.CASH} startIcon={<ArrowBackRounded />} sx={{ mb: 2 }}>
          Cash
        </Button>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && <Alert severity="error">No se pudo cargar esta entrega. Inténtalo de nuevo.</Alert>}

        {drop && (
          <Stack spacing={3}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h4" sx={{ fontWeight: 600 }}>
                  {formatMoney(drop.amount)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {drop.agent?.name} · {formatDate(drop.created_at)}
                </Typography>
              </Box>
              <Chip color={DROP_COLOR[drop.status]} label={DROP_LABEL[drop.status]} />
            </Stack>

            <Card variant="outlined">
              <CardContent>
                <Stack spacing={1}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Saldo del agente al entregar</Typography>
                    <Typography>{formatMoney(drop.balance_before)}</Typography>
                  </Stack>
                  {drop.note && (
                    <>
                      <Divider sx={{ my: 1 }} />
                      <Typography variant="body2" color="text.secondary">
                        Nota del agente
                      </Typography>
                      <Typography variant="body2">{drop.note}</Typography>
                    </>
                  )}
                </Stack>
              </CardContent>
            </Card>

            {/* Terminal: show the decision (mirrors the retired closure detail). */}
            {!isPending && (
              <Alert severity={drop.status === 'confirmed' ? 'success' : 'error'}>
                {drop.status === 'confirmed' ? 'Recibo confirmado' : 'Rechazado'}
                {drop.reviewed_at ? ` el ${formatDate(drop.reviewed_at)}` : ''}
                {drop.review_note ? ` — ${drop.review_note}` : ''}
              </Alert>
            )}

            {review.isError && (
              <Alert severity="error">No se pudo enviar tu decisión. Inténtalo de nuevo.</Alert>
            )}

            {isPending && (
              <Stack direction="row" spacing={2}>
                <Button
                  variant="contained"
                  color="success"
                  size="large"
                  disableElevation
                  fullWidth
                  onClick={confirm}
                  disabled={review.isPending}
                >
                  Confirmar recibo
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  size="large"
                  fullWidth
                  onClick={() => setRejectOpen(true)}
                  disabled={review.isPending}
                >
                  Rechazar
                </Button>
              </Stack>
            )}
          </Stack>
        )}

        <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} fullWidth maxWidth="xs">
          <DialogTitle>¿Rechazar esta entrega?</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              El agente sigue siendo responsable de este efectivo — su saldo no cambia. Agrega una nota explicando por qué (ej. una diferencia en el monto).
            </Typography>
            <TextField
              label="Razón (opcional)"
              fullWidth
              multiline
              minRows={2}
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRejectOpen(false)}>Mantener pendiente</Button>
            <Button
              variant="contained"
              color="error"
              disableElevation
              onClick={reject}
              disabled={review.isPending}
            >
              {review.isPending ? 'Rechazando…' : 'Rechazar'}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Fade>
  )
}
