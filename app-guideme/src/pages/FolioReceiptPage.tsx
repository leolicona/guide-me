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
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import EventAvailableRounded from '@mui/icons-material/EventAvailableRounded'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import PaidRounded from '@mui/icons-material/PaidRounded'
import {
  useFolio,
  useSettleBooking,
  useCancelBooking,
  useReactivateBooking,
} from '../features/pos/hooks'
import { TicketQr } from '../features/pos/components/TicketQr'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

export default function FolioReceiptPage() {
  const { id } = useParams<{ id: string }>()
  const { data: folio, isLoading, isError } = useFolio(id)
  const settle = useSettleBooking()
  const cancel = useCancelBooking()
  const reactivate = useReactivateBooking()

  const isBooking = folio?.status === 'booking'
  // A cancelled folio that carries a booking expiry was an apartado (US-AG07.5 late arrival).
  const isExpiredBooking =
    folio?.status === 'cancelled' && folio?.booking_expires_at != null
  const busy = settle.isPending || cancel.isPending || reactivate.isPending

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 640, mx: 'auto' }}>
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudo cargar este folio. Inténtalo de nuevo.</Alert>
        )}

        {folio && (
          <Stack spacing={3}>
            <Box sx={{ textAlign: 'center' }}>
              {isBooking ? (
                <EventAvailableRounded color="warning" sx={{ fontSize: 48 }} />
              ) : isExpiredBooking ? (
                <EventBusyRounded color="disabled" sx={{ fontSize: 48 }} />
              ) : (
                <CheckCircleRounded color="success" sx={{ fontSize: 48 }} />
              )}
              <Typography variant="h5" component="h1" sx={{ mt: 1 }}>
                {isBooking
                  ? 'Apartado registrado'
                  : isExpiredBooking
                    ? 'Apartado vencido'
                    : 'Venta confirmada'}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                Folio {folio.id}
              </Typography>
              {folio.customer_email && (
                <Typography variant="body2" color="success.main" sx={{ mt: 1 }}>
                  📧 {isBooking ? 'Comprobante de apartado enviado a' : 'Recibo enviado a'}{' '}
                  {folio.customer_email}
                </Typography>
              )}
            </Box>

            {isExpiredBooking && (
              <Alert severity="warning" icon={<EventBusyRounded />}>
                Apartado Expirado — Cupos Liberados. Reactívalo para volver a bloquear los
                lugares (si aún hay cupo) y cobrar el saldo.
              </Alert>
            )}

            <Card>
              <CardContent>
                <Stack
                  direction="row"
                  sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
                >
                  <Typography variant="h6">Recibo</Typography>
                  <Chip
                    size="small"
                    color={isBooking ? 'warning' : folio.status === 'cancelled' ? 'default' : 'success'}
                    variant="outlined"
                    label={isBooking ? 'Apartado' : folio.status === 'cancelled' ? 'Cancelado' : 'Pagado'}
                  />
                </Stack>

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
                    <Typography color="text.secondary">{isBooking ? 'Anticipo' : 'Pagado'}</Typography>
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
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Método de pago</Typography>
                    <Typography>
                      {folio.payment_method === 'card' ? 'Tarjeta' : 'Efectivo'}
                    </Typography>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

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

            {/* US-AG07 — booking actions: settle (one-shot) or cancel (non-refundable). */}
            {isBooking && (
              <Stack spacing={1.5}>
                <Button
                  variant="contained"
                  size="large"
                  disableElevation
                  startIcon={<PaidRounded />}
                  disabled={busy}
                  onClick={() => settle.mutate(folio.id)}
                >
                  {settle.isPending ? 'Liquidando…' : 'Liquidar saldo'}
                </Button>
                <Button
                  color="inherit"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('¿Cancelar el apartado y liberar los lugares? El anticipo no es reembolsable.')) {
                      cancel.mutate({ id: folio.id })
                    }
                  }}
                >
                  Cancelar apartado
                </Button>
              </Stack>
            )}

            {/* US-AG07.5 — late-arrival contingency (reactivation only this phase). */}
            {isExpiredBooking && (
              <Stack spacing={1.5}>
                <Button
                  variant="contained"
                  size="large"
                  disableElevation
                  disabled={busy}
                  onClick={() => reactivate.mutate(folio.id)}
                >
                  {reactivate.isPending ? 'Reactivando…' : 'Reactivar y Liquidar'}
                </Button>
                {reactivate.isError && (
                  <Alert severity="error">
                    El tour ya no tiene cupo para reactivar este apartado.
                  </Alert>
                )}
                <Stack direction="row" spacing={1.5}>
                  <Button fullWidth disabled>
                    Reagendar (Próximamente)
                  </Button>
                  <Button fullWidth disabled>
                    Generar cupón (Próximamente)
                  </Button>
                </Stack>
              </Stack>
            )}

            <Button
              variant={isBooking || isExpiredBooking ? 'text' : 'contained'}
              disableElevation
              component={RouterLink}
              to={ROUTES.POS}
            >
              Nueva venta
            </Button>
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
