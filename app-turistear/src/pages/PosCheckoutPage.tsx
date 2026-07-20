import { useState } from 'react'
import { useNavigate, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Alert,
  Fade,
  Stack,
  Divider,
  TextField,
  InputAdornment,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Chip,
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
import { useMyOrganization } from '../features/organization'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import {
  usePosCart,
  toConfirmPayload,
  cartLineTotal,
  cartSubtotal,
  cartDiscountTotal,
  cartTotal,
  lineKey,
  type SlotCartLine,
} from '../store/posCart'
import { StayCartLine } from '../features/pos/components/StayCartLine'
import { ServiceError } from '../services/authService'
import { formatMoney, amountToCents, centsToAmount } from '../features/catalog/types'
import { ROUTES } from '../config/routes'
import { SectionCard, MoneyText } from '../components'

// customer_email is mandatory at POS — it's the only delivery channel for the ticket + QR
// in Phase 1. Mirror the backend's validation so the agent gets immediate feedback.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// US-AG07 D4 — a booking needs a dialable phone (mirrors the server's ≥ 8-digit check).
const isDialable = (phone: string): boolean => phone.replace(/\D/g, '').length >= 8

// US-AG07.2 — the adaptive checkout's derived state from the entered amount vs the cart total
// and the org minimum deposit. Drives the button label/enablement and the sale type.
type SaleState = 'FULL' | 'PARTIAL' | 'INSUFFICIENT' | 'EXCESS' | 'EMPTY'

// Map a confirm error to an actionable banner message.
function errorMessage(error: unknown): string {
  if (error instanceof ServiceError) {
    if (error.code === 'SLOT_UNAVAILABLE') {
      return 'Un horario seleccionado se agotó — por favor revisa tu carrito e inténtalo de nuevo.'
    }
    // US-A47 — the slot's departure passed the sales cutoff (it's no longer sellable).
    if (error.code === 'SLOT_CLOSED') {
      return 'Un horario ya cerró para venta (su salida pasó el límite). Quítalo del carrito para continuar.'
    }
    if (error.code === 'PRICE_BELOW_MINIMUM') {
      return 'Un artículo tiene un precio por debajo del mínimo — ajusta el descuento e inténtalo de nuevo.'
    }
    if (error.code === 'NOT_FOUND') {
      return 'Un servicio u horario seleccionado ya no está disponible. Por favor, vuelve a armar tu carrito.'
    }
    // US-AG38 (v2) — lodging confirm errors (per-night count guard).
    if (error.code === 'INSUFFICIENT_INVENTORY') {
      return 'Ya no hay habitaciones suficientes para esas fechas — alguien más las tomó. Quita la estancia del carrito y vuelve a elegirla.'
    }
    if (error.code === 'MIN_STAY_NOT_MET') {
      return 'Una estancia no cumple la estancia mínima de noches. Ajústala e inténtalo de nuevo.'
    }
  }
  return 'No se pudo completar la venta. Por favor, inténtalo de nuevo.'
}

// The discount lives here now (US: moved out of the Bottom Sheet, which only secures
// inventory). Edits are kept local so typing isn't fought by the store's clamp; on blur the
// price commits and snaps back into [minimum, base]. The store remains authoritative.
function LinePriceField({ line }: { line: SlotCartLine }) {
  const setUnitPrice = usePosCart((s) => s.setUnitPrice)
  const [value, setValue] = useState(String(centsToAmount(line.unit_price)))

  const min = line.service.minimum_price
  const base = line.service.base_price
  const cents = value === '' ? NaN : amountToCents(Number(value))
  const belowMin = cents < min
  const aboveBase = cents > base
  const invalid = Number.isNaN(cents) || belowMin || aboveBase

  const commit = () => {
    const clamped = Number.isNaN(cents)
      ? line.unit_price
      : Math.min(Math.max(cents, min), base)
    setUnitPrice(lineKey(line), clamped)
    setValue(String(centsToAmount(clamped)))
  }

  return (
    <TextField
      label="Precio unitario"
      type="number"
      size="small"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      error={value !== '' && invalid}
      helperText={
        belowMin
          ? `Mínimo ${formatMoney(min)}`
          : aboveBase
            ? `Máximo ${formatMoney(base)}`
            : `Mín ${formatMoney(min)} · base ${formatMoney(base)}`
      }
      slotProps={{
        input: {
          startAdornment: <InputAdornment position="start">$</InputAdornment>,
        },
        htmlInput: {
          min: centsToAmount(min),
          max: centsToAmount(base),
          step: 0.01,
          inputMode: 'decimal',
        },
      }}
      sx={{ mt: 1.5, width: 180 }}
    />
  )
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
  const user = useCurrentUser()
  // Affiliate-portal D8: the ticket is addressed to the affiliate's own account email, so the
  // customer email here is an OPTIONAL copy to the tourist. For an agent/admin it stays the
  // mandatory delivery channel.
  const isAffiliate = user.role === 'affiliate'

  const emailTrimmed = customerEmail.trim()
  const emailValid = isAffiliate
    ? emailTrimmed === '' || EMAIL_RE.test(emailTrimmed)
    : EMAIL_RE.test(emailTrimmed)

  // US-AG07.2 — adaptive, amount-driven checkout. The amount input pre-loads the cart total; the
  // sale type / button / validity derive from it. A suggested-deposit chip reuses the org minimum %.
  const { data: org } = useMyOrganization()
  const total = cartTotal(lines)
  const minPct = org?.booking_min_down_payment_pct ?? 0
  const minCents = Math.ceil((total * minPct) / 100)
  const suggestedCents = minPct > 0 ? minCents : 0

  const [amountInput, setAmountInput] = useState(() => String(centsToAmount(total)))
  // Reset the amount to the total whenever the cart total changes (render-phase, no effect).
  const [prevTotal, setPrevTotal] = useState(total)
  if (total !== prevTotal) {
    setPrevTotal(total)
    setAmountInput(String(centsToAmount(total)))
  }
  const amountCents =
    amountInput.trim() === '' ? NaN : amountToCents(Number(amountInput))

  const saleState: SaleState =
    Number.isNaN(amountCents) || amountCents <= 0
      ? 'EMPTY'
      : amountCents > total
        ? 'EXCESS'
        : amountCents === total
          ? 'FULL'
          : amountCents >= minCents
            ? 'PARTIAL'
            : 'INSUFFICIENT'

  const chipLit = suggestedCents > 0 && amountCents === suggestedCents
  const phoneOk = isDialable(customerPhone)
  // A booking additionally requires a dialable phone (D4).
  const canSubmit =
    !confirm.isPending &&
    emailValid &&
    (saleState === 'FULL' || (saleState === 'PARTIAL' && phoneOk))

  const buttonLabel = confirm.isPending
    ? saleState === 'FULL'
      ? 'Cobrando…'
      : 'Registrando…'
    : saleState === 'FULL'
      ? 'Cobrar' // verb glossary (US-UX05)
      : saleState === 'PARTIAL'
        ? 'Registrar apartado'
        : saleState === 'INSUFFICIENT'
          ? `Mínimo ${formatMoney(minCents)}`
          : saleState === 'EXCESS'
            ? 'Excede el total'
            : 'Captura un monto'

  const handleConfirm = () => {
    // Read the current state directly so the payload reflects any last edits.
    const payload = toConfirmPayload(usePosCart.getState())
    if (saleState === 'PARTIAL') payload.down_payment = amountCents
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

            <SectionCard>
                <Stack spacing={2} divider={<Divider flexItem />}>
                  {lines.map((line) =>
                    line.kind === 'stay' ? (
                      <StayCartLine
                        key={lineKey(line)}
                        line={line}
                        onRemove={() => removeLine(lineKey(line))}
                      />
                    ) : (
                      <Box key={lineKey(line)}>
                        <Stack
                          direction="row"
                          spacing={1}
                          sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                        >
                          <Box sx={{ minWidth: 0 }}>
                            <Typography variant="subtitle2">{line.service.name}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {line.slot.date} · {line.slot.start_time}
                              {line.zone ? ` · ${line.zone.name}` : ''}
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
                            <LinePriceField line={line} />
                          </Box>
                          <Stack spacing={0.5} sx={{ alignItems: 'flex-end' }}>
                            <Typography variant="subtitle2">
                              {formatMoney(cartLineTotal(line))}
                            </Typography>
                            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                              <IconButton
                                size="small"
                                aria-label="Menos personas"
                                onClick={() => updateQuantity(lineKey(line), line.quantity - 1)}
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
                                onClick={() => updateQuantity(lineKey(line), line.quantity + 1)}
                                disabled={line.quantity >= line.slot.remaining}
                              >
                                <AddRounded fontSize="small" />
                              </IconButton>
                              <IconButton
                                size="small"
                                aria-label="Eliminar artículo"
                                onClick={() => removeLine(lineKey(line))}
                              >
                                <DeleteOutlineRounded fontSize="small" />
                              </IconButton>
                            </Stack>
                          </Stack>
                        </Stack>
                      </Box>
                    ),
                  )}
                </Stack>
            </SectionCard>

            <SectionCard title="Cliente">
                <Stack spacing={2}>
                  <TextField
                    label="Nombre (opcional)"
                    size="small"
                    value={customerName}
                    onChange={(e) => setCustomer({ name: e.target.value })}
                  />
                  <TextField
                    label={isAffiliate ? 'Copia al cliente (opcional)' : 'Correo electrónico'}
                    size="small"
                    type="email"
                    required={!isAffiliate}
                    value={customerEmail}
                    onChange={(e) => setCustomer({ email: e.target.value })}
                    error={emailTrimmed.length > 0 && !emailValid}
                    helperText={
                      emailTrimmed.length > 0 && !emailValid
                        ? 'Ingresa un correo electrónico válido.'
                        : isAffiliate
                          ? 'El boleto QR se envía a tu correo; agrega uno para enviarle copia al cliente.'
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
            </SectionCard>

            <SectionCard title="Método de pago">
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
            </SectionCard>

            <SectionCard>
                <Stack spacing={1}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Subtotal</Typography>
                    <Typography className="numeric">{formatMoney(cartSubtotal(lines))}</Typography>
                  </Stack>
                  {cartDiscountTotal(lines) > 0 && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Descuento</Typography>
                      <Typography className="numeric">−{formatMoney(cartDiscountTotal(lines))}</Typography>
                    </Stack>
                  )}
                  <Divider sx={{ my: 1 }} />
                  {/* The dominant figure — money reads first. */}
                  <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Typography variant="h6">Total</Typography>
                    <MoneyText cents={cartTotal(lines)} variant="h2" srLabel="Total a cobrar" />
                  </Stack>
                </Stack>
            </SectionCard>

            {/* US-AG07.2 — adaptive amount: full total in one tap, or convert to an apartado. */}
            <SectionCard>
                <Stack
                  direction="row"
                  sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
                >
                  <Typography variant="h6">Monto a cobrar</Typography>
                  {suggestedCents > 0 && (
                    <Chip
                      label={`Apartar ${minPct}% · ${formatMoney(suggestedCents)}`}
                      color="primary"
                      variant={chipLit ? 'filled' : 'outlined'}
                      onClick={() => setAmountInput(String(centsToAmount(suggestedCents)))}
                      size="small"
                    />
                  )}
                </Stack>
                <TextField
                  label="Monto recibido"
                  type="number"
                  fullWidth
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  error={saleState === 'INSUFFICIENT' || saleState === 'EXCESS'}
                  slotProps={{
                    input: {
                      startAdornment: <InputAdornment position="start">$</InputAdornment>,
                    },
                    htmlInput: { min: 0, step: 0.01, inputMode: 'decimal' },
                  }}
                  helperText={
                    saleState === 'PARTIAL'
                      ? `Apartado · Saldo pendiente ${formatMoney(total - amountCents)}${minPct > 0 ? ` · Mínimo ${formatMoney(minCents)}` : ''}`
                      : saleState === 'FULL'
                        ? 'Pago total'
                        : saleState === 'INSUFFICIENT'
                          ? `Por debajo del mínimo (${formatMoney(minCents)})`
                          : saleState === 'EXCESS'
                            ? `No puede exceder el total (${formatMoney(total)})`
                            : 'Captura el monto recibido'
                  }
                />
                {saleState === 'PARTIAL' && !phoneOk && (
                  <Typography variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
                    Un apartado requiere un teléfono válido para dar seguimiento por WhatsApp.
                  </Typography>
                )}
            </SectionCard>

            {/* One confident teal action, pinned to the thumb zone — reachable one-handed as the
                page scrolls (brief principle 3: reach & repetition). */}
            <Box
              sx={{
                position: 'sticky',
                bottom: 0,
                pt: 2,
                pb: 2,
                mt: 1,
                backgroundColor: 'background.default',
                borderTop: '1px solid',
                borderColor: 'divider',
                zIndex: 1,
              }}
            >
              <Button
                variant="contained"
                size="large"
                fullWidth
                onClick={handleConfirm}
                disabled={!canSubmit}
              >
                {buttonLabel}
              </Button>
              {!emailValid && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', textAlign: 'center', mt: 1 }}
                >
                  Captura el correo del cliente para enviar el boleto y poder cobrar.
                </Typography>
              )}
            </Box>
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
