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
import { useFolio } from '../features/pos/hooks'
import { TicketQr } from '../features/pos/components/TicketQr'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

export default function FolioReceiptPage() {
  const { id } = useParams<{ id: string }>()
  const { data: folio, isLoading, isError } = useFolio(id)

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
              <CheckCircleRounded color="success" sx={{ fontSize: 48 }} />
              <Typography variant="h5" component="h1" sx={{ mt: 1 }}>
                Venta confirmada
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                Folio {folio.id}
              </Typography>
              {folio.customer_email && (
                <Typography variant="body2" color="success.main" sx={{ mt: 1 }}>
                  📧 Recibo enviado a {folio.customer_email}
                </Typography>
              )}
            </Box>

            <Card>
              <CardContent>
                <Stack
                  direction="row"
                  sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
                >
                  <Typography variant="h6">Recibo</Typography>
                  <Chip size="small" color="success" variant="outlined" label="Pagado" />
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



            <Button
              variant="contained"
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
