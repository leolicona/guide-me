import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import {
  useApproveCancellationRequest,
  useCancellationRequests,
  useRejectCancellationRequest,
} from '../hooks'
import type { CancellationRequest, CancellationRequestStatus } from '../types'
import { formatMoney } from '../../catalog/types'
import { ROUTES } from '../../../config/routes'
import { useOrgDateFormatter } from '../../organization'

const REQUEST_COLOR: Record<CancellationRequestStatus, 'warning' | 'success' | 'error'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
}

const REQUEST_LABEL: Record<CancellationRequestStatus, string> = {
  pending: 'Pendiente',
  approved: 'Aprobada',
  rejected: 'Rechazada',
}

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// US-T04 — the tourists' cancellation-request review queue. Approving runs the full
// US-A21 cancellation (seats released, client emailed) and — on a paid folio — opens the
// refund obligation with a portal PIN; rejecting requires a note the tourist will read.
export function CancellationRequestsTab() {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
  const [filter, setFilter] = useState<CancellationRequestStatus | 'all'>('pending')
  const { data: requests, isLoading, isError } = useCancellationRequests(filter)
  const approve = useApproveCancellationRequest()
  const reject = useRejectCancellationRequest()

  const [approveTarget, setApproveTarget] = useState<CancellationRequest | null>(null)
  const [clawback, setClawback] = useState(false)
  const [rejectTarget, setRejectTarget] = useState<CancellationRequest | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  const submitApprove = () => {
    if (!approveTarget) return
    approve.mutate(
      { id: approveTarget.id, input: { clawback } },
      { onSuccess: () => setApproveTarget(null) },
    )
  }

  const submitReject = () => {
    if (!rejectTarget || !rejectNote.trim()) return
    reject.mutate(
      { id: rejectTarget.id, input: { note: rejectNote.trim() } },
      { onSuccess: () => setRejectTarget(null) },
    )
  }

  return (
    <Box>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={filter}
        onChange={(_, v) => v && setFilter(v)}
        sx={{ mb: 3 }}
      >
        <ToggleButton value="pending">Pendientes</ToggleButton>
        <ToggleButton value="approved">Aprobadas</ToggleButton>
        <ToggleButton value="rejected">Rechazadas</ToggleButton>
        <ToggleButton value="all">Todas</ToggleButton>
      </ToggleButtonGroup>

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}
      {isError && (
        <Alert severity="error">No se pudieron cargar las solicitudes. Inténtalo de nuevo.</Alert>
      )}

      {requests && requests.length === 0 && (
        <Typography color="text.secondary">No hay solicitudes para mostrar.</Typography>
      )}

      {requests && requests.length > 0 && (
        <Stack spacing={2}>
          {requests.map((req) => (
            <Card key={req.id} variant="outlined">
              <CardContent>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" noWrap>
                      {req.folio.customer_name ?? 'Sin nombre'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatDate(req.created_at)} · {formatMoney(req.folio.total)} · pagado{' '}
                      {formatMoney(req.folio.amount_paid)}
                    </Typography>
                  </Box>
                  <Chip size="small" color={REQUEST_COLOR[req.status]} label={REQUEST_LABEL[req.status]} />
                </Stack>

                {req.reason && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    Motivo del cliente: {req.reason}
                  </Typography>
                )}
                {req.status === 'rejected' && req.resolution_note && (
                  <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                    Resolución: {req.resolution_note}
                  </Typography>
                )}

                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  {req.status === 'pending' && (
                    <>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => {
                          setClawback(false)
                          setApproveTarget(req)
                        }}
                      >
                        Aprobar cancelación
                      </Button>
                      <Button
                        size="small"
                        color="inherit"
                        onClick={() => {
                          setRejectNote('')
                          setRejectTarget(req)
                        }}
                      >
                        Rechazar
                      </Button>
                    </>
                  )}
                  <Button
                    size="small"
                    component={RouterLink}
                    to={ROUTES.FOLIO_DETAIL.replace(':id', req.folio_id)}
                  >
                    Ver folio
                  </Button>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      {/* Approve — spells out everything the action triggers (cancel + seats + email + PIN). */}
      <Dialog open={!!approveTarget} onClose={() => setApproveTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>¿Aprobar la cancelación?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Esto cancela el folio completo: libera todos los lugares, notifica al cliente por
            correo y — si el folio tiene pago registrado — genera un PIN de reembolso que el
            cliente verá en su portal para reclamar su efectivo.
          </DialogContentText>
          <FormControlLabel
            sx={{ alignItems: 'flex-start' }}
            control={
              <Switch checked={clawback} onChange={(e) => setClawback(e.target.checked)} color="error" />
            }
            label={
              <Box sx={{ pt: 0.75 }}>
                <Typography variant="body2">Recuperar comisión del agente</Typography>
                <Typography variant="caption" color="text.secondary">
                  {clawback
                    ? 'El agente pierde la comisión generada en esta venta.'
                    : 'Desactivado: la empresa absorbe la pérdida y el agente conserva la comisión.'}
                </Typography>
              </Box>
            }
          />
          {approve.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              No se pudo aprobar la solicitud. Inténtalo de nuevo.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setApproveTarget(null)}>Volver</Button>
          <Button
            variant="contained"
            color="error"
            disableElevation
            onClick={submitApprove}
            disabled={approve.isPending}
          >
            {approve.isPending ? 'Aprobando…' : 'Aprobar y cancelar folio'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reject — the note is required: the tourist reads it in their portal. */}
      <Dialog open={!!rejectTarget} onClose={() => setRejectTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Rechazar solicitud</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            La reserva sigue activa y nada cambia en el folio. Explica el motivo — el cliente lo
            verá en su portal.
          </DialogContentText>
          <TextField
            label="Motivo del rechazo"
            fullWidth
            multiline
            minRows={2}
            autoFocus
            required
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
          />
          {reject.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              No se pudo rechazar la solicitud. Inténtalo de nuevo.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectTarget(null)}>Volver</Button>
          <Button
            variant="contained"
            disableElevation
            onClick={submitReject}
            disabled={reject.isPending || !rejectNote.trim()}
          >
            {reject.isPending ? 'Rechazando…' : 'Rechazar solicitud'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
