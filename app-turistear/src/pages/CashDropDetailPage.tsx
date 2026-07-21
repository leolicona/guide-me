import { useState } from 'react'
import { useParams, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
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
import ReceiptLongRounded from '@mui/icons-material/ReceiptLong'
import LockRounded from '@mui/icons-material/Lock'
import { useDrop, useResolveDispute, useReviewDrop } from '../features/cash/hooks'
import { AckChip } from '../features/cash/components/AckChip'
import { SOURCE_LABEL } from '../features/cash/components/ackPresentation'
import type { DropStatus, ReviewDropInput } from '../features/cash/types'
import { formatMoney, amountToCents } from '../features/catalog/types'
import { ROUTES } from '../config/routes'
import { SectionCard, MoneyText, StatusChip, InfoPopover } from '../components'

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
  const resolve = useResolveDispute()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [resolveOpen, setResolveOpen] = useState(false)
  const [adjustAmount, setAdjustAmount] = useState('')
  const [note, setNote] = useState('')
  const [resolutionNote, setResolutionNote] = useState('')

  const isPending = drop?.status === 'pending'
  const isDisputed = drop?.acknowledgment === 'disputed'

  const submitResolution = () => {
    if (!id || !resolutionNote.trim()) return
    resolve.mutate(
      { id, input: { note: resolutionNote.trim() } },
      { onSuccess: () => setResolveOpen(false) },
    )
  }

  const confirm = () => {
    if (!id) return
    const trimmed = adjustAmount.trim()
    const input: ReviewDropInput = { decision: 'confirmed' }
    // Only send a corrected amount when the admin actually typed a different one.
    if (trimmed) {
      const cents = amountToCents(Number(trimmed))
      if (cents > 0 && cents !== drop?.amount) input.amount = cents
    }
    review.mutate({ id, input }, { onSuccess: () => setConfirmOpen(false) })
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
          Caja
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
                <MoneyText cents={drop.amount} variant="h2" srLabel="Monto de la entrega" />
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {drop.agent?.name} · {SOURCE_LABEL[drop.source]} · {formatDate(drop.created_at)}
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <AckChip state={drop.acknowledgment} size="medium" />
                <Chip color={DROP_COLOR[drop.status]} label={DROP_LABEL[drop.status]} />
              </Stack>
            </Stack>

            <SectionCard>
                <Stack spacing={1}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Saldo del agente al entregar</Typography>
                    <Typography className="numeric">{formatMoney(drop.balance_before)}</Typography>
                  </Stack>
                  {drop.amount_requested != null && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Monto solicitado por el agente</Typography>
                      <Typography sx={{ textDecoration: 'line-through' }} color="text.secondary">
                        {formatMoney(drop.amount_requested)}
                      </Typography>
                    </Stack>
                  )}
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
            </SectionCard>

            {/* Terminal: show the decision (mirrors the retired closure detail). */}
            {!isPending && (
              <Alert severity={drop.status === 'confirmed' ? 'success' : 'error'}>
                {drop.status === 'confirmed' ? 'Recibo confirmado' : 'Rechazado'}
                {drop.reviewed_at ? ` el ${formatDate(drop.reviewed_at)}` : ''}
                {drop.review_note ? ` — ${drop.review_note}` : ''}
              </Alert>
            )}

            {/* US-A27/A28 (D5) — an open dispute from the agent. Resolution is audit-only:
                the money never moves here; a correction is a separate payout/collection. */}
            {isDisputed && (
              <Alert
                severity="warning"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => {
                      setResolutionNote('')
                      setResolveOpen(true)
                    }}
                    disabled={resolve.isPending}
                  >
                    Resolver
                  </Button>
                }
              >
                El agente disputó este movimiento{drop.ack_note ? `: “${drop.ack_note}”` : '.'}
              </Alert>
            )}
            {drop.acknowledgment === 'signed' && drop.acknowledged_at && (
              <Alert severity="success" icon={false}>
                Firmado por el agente el {formatDate(drop.acknowledged_at)}
              </Alert>
            )}
            {drop.acknowledgment === 'auto_signed' && drop.acknowledged_at && (
              <Alert severity="info" icon={false}>
                Firmado automáticamente el {formatDate(drop.acknowledged_at)} (sin respuesta del agente)
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
                  onClick={() => {
                    setAdjustAmount('')
                    setConfirmOpen(true)
                  }}
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

        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} fullWidth maxWidth="xs">
          <DialogTitle>Confirmar recibo</DialogTitle>
          <DialogContent>
            {/* The agent-registered amount shown as a reference chip; the adjustment mechanics
                (rarely needed) move behind the info tap. The field carries the actionable copy. */}
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }}
            >
              <StatusChip
                tone="neutral"
                icon={<ReceiptLongRounded />}
                label={`El agente registró ${drop ? formatMoney(drop.amount) : ''}`}
              />
              <InfoPopover label="Sobre el monto corregido">
                Si el efectivo difiere de lo registrado, captura el monto corregido — se descontará
                ese del saldo del agente y se registrará el ajuste.
              </InfoPopover>
            </Stack>
            <TextField
              label="Monto corregido (opcional)"
              type="number"
              fullWidth
              autoFocus
              placeholder={drop ? String(drop.amount / 100) : ''}
              helperText="Déjalo vacío para confirmar el monto solicitado."
              value={adjustAmount}
              onChange={(e) => setAdjustAmount(e.target.value)}
            />
            {review.isError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                No se pudo confirmar. Inténtalo de nuevo.
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmOpen(false)}>Cancelar</Button>
            <Button
              variant="contained"
              color="success"
              disableElevation
              onClick={confirm}
              disabled={review.isPending}
            >
              {review.isPending ? 'Confirmando…' : 'Confirmar recibo'}
            </Button>
          </DialogActions>
        </Dialog>

        {/* Resolve-dispute dialog (required note; no money change). */}
        <Dialog open={resolveOpen} onClose={() => setResolveOpen(false)} fullWidth maxWidth="xs">
          <DialogTitle>Resolver disputa</DialogTitle>
          <DialogContent>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }}
            >
              <StatusChip tone="neutral" icon={<LockRounded />} label="No cambia montos" />
              <InfoPopover label="Cómo corregir un monto">
                Si el agente tiene razón, registra después la corrección como un pago o un nuevo
                cobro. La resolución sólo cierra la disputa con una explicación.
              </InfoPopover>
            </Stack>
            <TextField
              label="Resolución"
              fullWidth
              multiline
              minRows={2}
              autoFocus
              required
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
            />
            {resolve.isError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                No se pudo resolver la disputa. Inténtalo de nuevo.
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setResolveOpen(false)}>Cancelar</Button>
            <Button
              variant="contained"
              disableElevation
              onClick={submitResolution}
              disabled={resolve.isPending || !resolutionNote.trim()}
            >
              {resolve.isPending ? 'Resolviendo…' : 'Resolver disputa'}
            </Button>
          </DialogActions>
        </Dialog>

        <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} fullWidth maxWidth="xs">
          <DialogTitle>¿Rechazar esta entrega?</DialogTitle>
          <DialogContent>
            <Box sx={{ mb: 2 }}>
              <StatusChip
                tone="neutral"
                icon={<LockRounded />}
                label="Su saldo no cambia · sigue responsable"
              />
            </Box>
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
