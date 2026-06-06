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
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import { useFolio } from '../features/pos/hooks'
import { TicketQr } from '../features/pos/components/TicketQr'
import type { FolioStatus } from '../features/pos/types'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

const STATUS_COLOR: Record<FolioStatus, 'success' | 'info' | 'error'> = {
  paid: 'success',
  booking: 'info',
  cancelled: 'error',
}

const STATUS_LABEL: Record<FolioStatus, string> = {
  paid: 'Pagado',
  booking: 'Reserva',
  cancelled: 'Cancelado',
}

const formatDate = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

// US-AG21 — read-only detail of one of the agent's own folios (answer customer queries,
// re-show the QR). Reuses GET /api/pos/folios/:id via useFolio. Status-aware framing; no
// cancel/edit affordance (cancellation is admin-only).
export default function FolioHistoryDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: folio, isLoading, isError } = useFolio(id)

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 640, mx: 'auto' }}>
        <Button
          component={RouterLink}
          to={ROUTES.HISTORY}
          startIcon={<ArrowBackRounded />}
          sx={{ mb: 2 }}
        >
          Historial
        </Button>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">
            No se pudo cargar este folio. Inténtalo de nuevo.
          </Alert>
        )}

        {folio && (
          <Stack spacing={3}>
            <Box>
              <Stack
                direction="row"
                sx={{ justifyContent: 'space-between', alignItems: 'center' }}
              >
                <Typography variant="h5" component="h1">
                  Folio
                </Typography>
                <Chip
                  size="small"
                  color={STATUS_COLOR[folio.status]}
                  label={STATUS_LABEL[folio.status]}
                />
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {folio.id} · {formatDate(folio.created_at)}
              </Typography>
            </Box>

            {folio.status === 'cancelled' && (
              <Alert severity="error">
                Este folio fue cancelado
                {folio.cancelled_at ? ` el ${formatDate(folio.cancelled_at)}` : ''}.
              </Alert>
            )}

            <Card>
              <CardContent>
                {(folio.customer_name || folio.customer_email) && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    {folio.customer_name}
                    {folio.customer_name && folio.customer_email ? ' · ' : ''}
                    {folio.customer_email}
                  </Typography>
                )}

                <Stack spacing={2} divider={<Divider flexItem />}>
                  {folio.lines.map((line) => (
                    <Box key={line.id}>
                      <Stack
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
                        <Typography variant="subtitle2">
                          {formatMoney(line.line_total)}
                        </Typography>
                      </Stack>
                    </Box>
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
                      <Typography color="text.secondary">Descuento</Typography>
                      <Typography>−{formatMoney(folio.discount_total)}</Typography>
                    </Stack>
                  )}
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography variant="h6">Total</Typography>
                    <Typography variant="h6">{formatMoney(folio.total)}</Typography>
                  </Stack>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Pagado</Typography>
                    <Typography>{formatMoney(folio.amount_paid)}</Typography>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

            <Box>
              <Typography variant="h6" sx={{ mb: 1.5 }}>
                Boletos de acceso
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Un QR por servicio. El cliente lo presenta a la entrada; un agente lo escanea
                para canjear un pase.
              </Typography>
              <Stack spacing={2}>
                {folio.lines.map((line) => (
                  <TicketQr key={line.id} line={line} />
                ))}
              </Stack>
            </Box>
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
