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
  DialogContentText,
  DialogActions,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import { useFolio, useCancelFolio } from '../features/folios/hooks'
import type { FolioStatus } from '../features/folios/types'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

const STATUS_COLOR: Record<FolioStatus, 'success' | 'info' | 'error'> = {
  paid: 'success',
  booking: 'info',
  cancelled: 'error',
}

const formatDate = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

export default function FolioDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: folio, isLoading, isError } = useFolio(id)
  const cancel = useCancelFolio()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reason, setReason] = useState('')

  const isCancelled = folio?.status === 'cancelled'

  const handleCancel = () => {
    if (!id) return
    cancel.mutate(
      { id, reason: reason.trim() || undefined },
      { onSuccess: () => setConfirmOpen(false) },
    )
  }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 640, mx: 'auto' }}>
        <Button component={RouterLink} to={ROUTES.FOLIOS} startIcon={<ArrowBackRounded />} sx={{ mb: 2 }}>
          Folios
        </Button>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && <Alert severity="error">Couldn't load this folio. Please try again.</Alert>}

        {folio && (
          <Stack spacing={3}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h5" component="h1" noWrap>
                  {folio.customer_name ?? 'Walk-in'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatDate(folio.created_at)} · {folio.agent.name}
                </Typography>
              </Box>
              <Chip size="small" color={STATUS_COLOR[folio.status]} label={folio.status} />
            </Stack>

            {isCancelled && (
              <Alert severity="error">
                Cancelled{folio.cancelled_at ? ` on ${formatDate(folio.cancelled_at)}` : ''}
                {folio.cancellation_reason ? ` — ${folio.cancellation_reason}` : ''}
              </Alert>
            )}

            <Card>
              <CardContent>
                {(folio.customer_email || folio.customer_phone) && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    {folio.customer_email}
                    {folio.customer_email && folio.customer_phone ? ' · ' : ''}
                    {folio.customer_phone}
                  </Typography>
                )}

                <Stack spacing={2} divider={<Divider flexItem />}>
                  {folio.lines.map((line) => (
                    <Stack
                      key={line.id}
                      direction="row"
                      sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle2">{line.service_name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {line.slot_date} · {line.slot_start_time} · {line.quantity}×{' '}
                          {formatMoney(line.unit_price)}
                        </Typography>
                        {line.extras.map((e) => (
                          <Typography
                            key={e.id}
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block' }}
                          >
                            + {e.quantity}× {e.name} ({formatMoney(e.price)})
                          </Typography>
                        ))}
                      </Box>
                      <Typography variant="subtitle2">{formatMoney(line.line_total)}</Typography>
                    </Stack>
                  ))}
                </Stack>

                <Divider sx={{ my: 2 }} />
                <Stack spacing={1}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Subtotal</Typography>
                    <Typography>{formatMoney(folio.subtotal)}</Typography>
                  </Stack>
                  {folio.discount_total > 0 && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Discount</Typography>
                      <Typography>−{formatMoney(folio.discount_total)}</Typography>
                    </Stack>
                  )}
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography variant="h6">Total</Typography>
                    <Typography variant="h6">{formatMoney(folio.total)}</Typography>
                  </Stack>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Paid</Typography>
                    <Typography>{formatMoney(folio.amount_paid)}</Typography>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

            {cancel.isError && (
              <Alert severity="error">Couldn't cancel this folio. Please try again.</Alert>
            )}

            {!isCancelled && (
              <Button
                variant="outlined"
                color="error"
                size="large"
                onClick={() => setConfirmOpen(true)}
              >
                Cancel folio
              </Button>
            )}
          </Stack>
        )}

        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
          <DialogTitle>Cancel this folio?</DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ mb: 2 }}>
              This releases all spots for every service in the folio and can't be undone. The
              client's access tickets will no longer be valid.
            </DialogContentText>
            <TextField
              label="Reason (optional)"
              size="small"
              fullWidth
              multiline
              minRows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmOpen(false)}>Keep folio</Button>
            <Button
              variant="contained"
              color="error"
              disableElevation
              onClick={handleCancel}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel folio'}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Fade>
  )
}
