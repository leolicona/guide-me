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
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import RemoveRounded from '@mui/icons-material/RemoveRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
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

// Map a confirm error to an actionable banner message.
function errorMessage(error: unknown): string {
  if (error instanceof ServiceError) {
    if (error.code === 'SLOT_UNAVAILABLE') {
      return 'A selected time just sold out — please review your cart and try again.'
    }
    if (error.code === 'PRICE_BELOW_MINIMUM') {
      return 'A line is priced below its minimum — adjust the discount and retry.'
    }
    if (error.code === 'NOT_FOUND') {
      return 'A selected service or time is no longer available. Please rebuild your cart.'
    }
  }
  return 'Could not complete the sale. Please try again.'
}

export default function PosCheckoutPage() {
  const lines = usePosCart((s) => s.lines)
  const customerName = usePosCart((s) => s.customerName)
  const customerEmail = usePosCart((s) => s.customerEmail)
  const customerPhone = usePosCart((s) => s.customerPhone)
  const setCustomer = usePosCart((s) => s.setCustomer)
  const updateQuantity = usePosCart((s) => s.updateQuantity)
  const removeLine = usePosCart((s) => s.removeLine)
  const clear = usePosCart((s) => s.clear)

  const navigate = useNavigate()
  const confirm = useConfirmSale()

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
          Services
        </Button>

        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Checkout
        </Typography>

        {lines.length === 0 ? (
          <Typography color="text.secondary">
            Your cart is empty.{' '}
            <RouterLink to={ROUTES.POS}>Browse services</RouterLink> to start a sale.
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
                            {formatMoney(line.unit_price)} each
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
                              aria-label="Fewer people"
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
                              aria-label="More people"
                              onClick={() => updateQuantity(line.slot.id, line.quantity + 1)}
                              disabled={line.quantity >= line.slot.remaining}
                            >
                              <AddRounded fontSize="small" />
                            </IconButton>
                            <IconButton
                              size="small"
                              aria-label="Remove line"
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
                  Customer (optional)
                </Typography>
                <Stack spacing={2}>
                  <TextField
                    label="Name"
                    size="small"
                    value={customerName}
                    onChange={(e) => setCustomer({ name: e.target.value })}
                  />
                  <TextField
                    label="Email"
                    size="small"
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomer({ email: e.target.value })}
                    helperText="Receipt & QR ticket are delivered here in a later step."
                  />
                  <TextField
                    label="Phone"
                    size="small"
                    value={customerPhone}
                    onChange={(e) => setCustomer({ phone: e.target.value })}
                  />
                </Stack>
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
                      <Typography color="text.secondary">Discount</Typography>
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
              disabled={confirm.isPending}
            >
              {confirm.isPending ? 'Confirming…' : 'Confirm sale'}
            </Button>
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
