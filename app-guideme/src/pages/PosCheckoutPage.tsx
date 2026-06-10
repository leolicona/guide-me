import { useNavigate, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  Alert,
  Fade,
  Stack,
  Divider,
  TextField,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import RemoveRounded from '@mui/icons-material/RemoveRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import CreditCardRounded from '@mui/icons-material/CreditCardRounded'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import LinkRounded from '@mui/icons-material/LinkRounded'
import { useConfirmSale } from '../features/pos/hooks'
import {
  usePosCart,
  toConfirmPayload,
  cartLineTotal,
  cartSubtotal,
  cartDiscountTotal,
  cartTotal,
} from '../store/posCart'
import { ServiceError } from '../services/authService'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

// customer_email is mandatory at POS — it's the only delivery channel for the ticket + QR
// in Phase 1. Mirror the backend's validation so the agent gets immediate feedback.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Map a confirm error to an actionable banner message.
function errorMessage(error: unknown): string {
  if (error instanceof ServiceError) {
    if (error.code === 'SLOT_UNAVAILABLE') {
      return 'Un horario seleccionado se agotó — por favor revisa tu carrito e inténtalo de nuevo.'
    }
    if (error.code === 'PRICE_BELOW_MINIMUM') {
      return 'Un artículo tiene un precio por debajo del mínimo — ajusta el descuento e inténtalo de nuevo.'
    }
    if (error.code === 'NOT_FOUND') {
      return 'Un servicio u horario seleccionado ya no está disponible. Por favor, vuelve a armar tu carrito.'
    }
  }
  return 'No se pudo completar la venta. Por favor, inténtalo de nuevo.'
}

export default function PosCheckoutPage() {
  const lines = usePosCart((s) => s.lines)
  const customerName = usePosCart((s) => s.customerName)
  const customerEmail = usePosCart((s) => s.customerEmail)
  const customerPhone = usePosCart((s) => s.customerPhone)
  const paymentMethod = usePosCart((s) => s.paymentMethod)
  const setCustomer = usePosCart((s) => s.setCustomer)
  const setPaymentMethod = usePosCart((s) => s.setPaymentMethod)
  const updateQuantity = usePosCart((s) => s.updateQuantity)
  const removeLine = usePosCart((s) => s.removeLine)
  const clear = usePosCart((s) => s.clear)

  const navigate = useNavigate()
  const confirm = useConfirmSale()

  const emailTrimmed = customerEmail.trim()
  const emailValid = EMAIL_RE.test(emailTrimmed)

  const handleConfirm = () => {
    // Read the current state directly so the payload reflects any last edits.
    const payload = toConfirmPayload(usePosCart.getState())
    confirm.mutate(payload, {
      onSuccess: (folio) => {
        clear()
        navigate(ROUTES.FOLIO.replace(':id', folio.id))
      },
    })
  }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 640, mx: 'auto' }}>
        <Button component={RouterLink} to={ROUTES.POS} startIcon={<ArrowBackRounded />} sx={{ mb: 2 }}>
          Servicios
        </Button>

        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Cobrar
        </Typography>

        {lines.length === 0 ? (
          <Typography color="text.secondary">
            Tu carrito está vacío.{' '}
            <RouterLink to={ROUTES.POS}>Explora los servicios</RouterLink> para iniciar una venta.
          </Typography>
        ) : (
          <Stack spacing={3}>
            {confirm.isError && (
              <Alert severity="error">{errorMessage(confirm.error)}</Alert>
            )}

            <Card>
              <CardContent>
                <Stack spacing={2} divider={<Divider flexItem />}>
                  {lines.map((line) => (
                    <Box key={line.slot.id}>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="subtitle2">{line.service.name}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {line.slot.date} · {line.slot.start_time} ·{' '}
                            {formatMoney(line.unit_price)} cada uno
                          </Typography>
                          {line.extras.map((e) => (
                            <Typography
                              key={e.extra.id}
                              variant="caption"
                              color="text.secondary"
                              sx={{ display: 'block' }}
                            >
                              + {e.quantity}× {e.extra.name} ({formatMoney(e.extra.price)})
                            </Typography>
                          ))}
                        </Box>
                        <Stack spacing={0.5} sx={{ alignItems: 'flex-end' }}>
                          <Typography variant="subtitle2">
                            {formatMoney(cartLineTotal(line))}
                          </Typography>
                          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                            <IconButton
                              size="small"
                              aria-label="Menos personas"
                              onClick={() => updateQuantity(line.slot.id, line.quantity - 1)}
                              disabled={line.quantity <= 1}
                            >
                              <RemoveRounded fontSize="small" />
                            </IconButton>
                            <Typography sx={{ minWidth: 24, textAlign: 'center' }}>
                              {line.quantity}
                            </Typography>
                            <IconButton
                              size="small"
                              aria-label="Más personas"
                              onClick={() => updateQuantity(line.slot.id, line.quantity + 1)}
                              disabled={line.quantity >= line.slot.remaining}
                            >
                              <AddRounded fontSize="small" />
                            </IconButton>
                            <IconButton
                              size="small"
                              aria-label="Eliminar artículo"
                              onClick={() => removeLine(line.slot.id)}
                            >
                              <DeleteOutlineRounded fontSize="small" />
                            </IconButton>
                          </Stack>
                        </Stack>
                      </Stack>
                    </Box>
                  ))}
                </Stack>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  Cliente
                </Typography>
                <Stack spacing={2}>
                  <TextField
                    label="Nombre (opcional)"
                    size="small"
                    value={customerName}
                    onChange={(e) => setCustomer({ name: e.target.value })}
                  />
                  <TextField
                    label="Correo electrónico"
                    size="small"
                    type="email"
                    required
                    value={customerEmail}
                    onChange={(e) => setCustomer({ email: e.target.value })}
                    error={emailTrimmed.length > 0 && !emailValid}
                    helperText={
                      emailTrimmed.length > 0 && !emailValid
                        ? 'Ingresa un correo electrónico válido.'
                        : 'Obligatorio — el recibo y el boleto QR se envían a este correo.'
                    }
                  />
                  <TextField
                    label="Teléfono"
                    size="small"
                    value={customerPhone}
                    onChange={(e) => setCustomer({ phone: e.target.value })}
                  />
                </Stack>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  Método de pago
                </Typography>
                {/* US-AG29 — four methods; everything except Efectivo is electronic (no
                    cash debt, commission still earned). Two rows so each stays tappable. */}
                <Stack spacing={1}>
                  <ToggleButtonGroup
                    exclusive
                    fullWidth
                    value={paymentMethod}
                    onChange={(_, value) => value && setPaymentMethod(value)}
                    aria-label="Método de pago"
                  >
                    <ToggleButton value="cash" aria-label="Efectivo">
                      <PaymentsRounded fontSize="small" sx={{ mr: 1 }} />
                      Efectivo
                    </ToggleButton>
                    <ToggleButton value="card" aria-label="Tarjeta">
                      <CreditCardRounded fontSize="small" sx={{ mr: 1 }} />
                      Tarjeta
                    </ToggleButton>
                  </ToggleButtonGroup>
                  <ToggleButtonGroup
                    exclusive
                    fullWidth
                    value={paymentMethod}
                    onChange={(_, value) => value && setPaymentMethod(value)}
                    aria-label="Método de pago electrónico"
                  >
                    <ToggleButton value="transfer" aria-label="Transferencia">
                      <AccountBalanceRounded fontSize="small" sx={{ mr: 1 }} />
                      Transferencia
                    </ToggleButton>
                    <ToggleButton value="link" aria-label="Link de pago">
                      <LinkRounded fontSize="small" sx={{ mr: 1 }} />
                      Link de pago
                    </ToggleButton>
                  </ToggleButtonGroup>
                </Stack>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mt: 1.5 }}
                >
                  {paymentMethod === 'cash'
                    ? 'Efectivo recibido — se suma al saldo de caja que entregas a la empresa.'
                    : 'Cobro electrónico — lo recibe la empresa: no suma efectivo a tu caja, pero sí genera comisión.'}
                </Typography>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Stack spacing={1}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Subtotal</Typography>
                    <Typography>{formatMoney(cartSubtotal(lines))}</Typography>
                  </Stack>
                  {cartDiscountTotal(lines) > 0 && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Descuento</Typography>
                      <Typography>−{formatMoney(cartDiscountTotal(lines))}</Typography>
                    </Stack>
                  )}
                  <Divider sx={{ my: 1 }} />
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography variant="h6">Total</Typography>
                    <Typography variant="h6">{formatMoney(cartTotal(lines))}</Typography>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

            <Button
              variant="contained"
              size="large"
              disableElevation
              onClick={handleConfirm}
              disabled={confirm.isPending || !emailValid}
            >
              {confirm.isPending ? 'Confirmando…' : 'Confirmar venta'}
            </Button>
            {!emailValid && (
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                Captura el correo del cliente para enviar el boleto y confirmar la venta.
              </Typography>
            )}
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
