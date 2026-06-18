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
import { BookingActions, ExpiredBookingBanner, venceLabel } from '../features/bookings'
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

  const isBooking = folio?.status === 'booking'

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
              {/* US-AG07.3 — live apartado countdown, inline on the existing detail. */}
              {isBooking && folio.booking_expires_at != null && (
                <Typography
                  variant="caption"
                  color="warning.main"
                  sx={{ display: 'block', mt: 0.5, fontWeight: 600 }}
                >
                  {venceLabel(folio.booking_expires_at)}
                </Typography>
              )}
            </Box>

            {/* A plain (admin) cancellation keeps the neutral notice; an expired apartado gets
                the reactivation banner instead (US-AG07.5). */}
            {folio.status === 'cancelled' && folio.booking_expires_at == null && (
              <Alert severity="error">
                Este folio fue cancelado
                {folio.cancelled_at ? ` el ${formatDate(folio.cancelled_at)}` : ''}.
              </Alert>
            )}
            <ExpiredBookingBanner folio={folio} />

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
                    <Typography color="text.secondary">
                      {isBooking ? 'Anticipo' : 'Pagado'}
                    </Typography>
                    <Typography>{formatMoney(folio.amount_paid)}</Typography>
                  </Stack>
                  {isBooking && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Saldo pendiente</Typography>
                      <Typography color="primary">
                        {formatMoney(folio.pending_balance ?? folio.total - folio.amount_paid)}
                      </Typography>
                    </Stack>
                  )}
                </Stack>
              </CardContent>
            </Card>

            {/* QR access only exists once the folio is paid — a live/expired apartado has none. */}
            {folio.status === 'paid' && (
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
            )}

            {/* US-AG07/07.4/07.5 — Liquidar/Cancelar (live) or Reactivar (expired), dynamically
                incorporated into this existing detail. Renders nothing for paid/plain folios. */}
            <BookingActions folio={folio} />
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
