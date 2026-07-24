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
  Tooltip,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import RemoveRounded from '@mui/icons-material/RemoveRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import HourglassTopRounded from '@mui/icons-material/HourglassTopRounded'
import SavingsRounded from '@mui/icons-material/SavingsRounded'
import { useConfirmSale } from '../features/pos/hooks'
import { useMyOrganization } from '../features/organization'
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
import { SectionCard, MoneyText, InfoPopover } from '../components'
import { isSendablePhone } from '../features/pos/phone'

// customer_email is mandatory at POS — it's the only delivery channel for the ticket + QR
// in Phase 1. Mirror the backend's validation so the agent gets immediate feedback.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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
      placeholder="0.00"
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
        inputLabel: { shrink: true },
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
  // D2 (whatsapp-qr-delivery) — every POS sale now requires a name + a sendable phone (WhatsApp
  // is the primary ticket-delivery channel); email drops to an optional copy, valid if present.
  const emailTrimmed = customerEmail.trim()
  const emailValid = emailTrimmed === '' || EMAIL_RE.test(emailTrimmed)
  const nameValid = customerName.trim().length > 0
  const phoneValid = isSendablePhone(customerPhone)
  // US-AG41 — a bank transfer needs a reference (≥ 4 chars). The customer's tickets are then held
  // until an admin verifies the money (US-A67). Local state — it isn't persisted with the cart.
  const [reference, setReference] = useState('')
  const referenceValid = paymentMethod !== 'transfer' || reference.trim().length >= 4

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
  // Name + phone are required for EVERY sale now (D2); email only has to be valid-if-present.
  const canSubmit =
    !confirm.isPending &&
    nameValid &&
    phoneValid &&
    emailValid &&
    referenceValid &&
    (saleState === 'FULL' || saleState === 'PARTIAL')

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
    // US-AG41 — carry the transfer reference (ignored server-side for other methods).
    if (paymentMethod === 'transfer') payload.payment_reference = reference.trim()
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
                              <Tooltip
                                title={
                                  line.quantity >= line.slot.remaining
                                    ? `Máximo disponible: ${line.slot.remaining}`
                                    : ''
                                }
                                enterTouchDelay={0}
                              >
                                {/* span keeps the tooltip reachable while the button is disabled */}
                                <span>
                                  <IconButton
                                    size="small"
                                    aria-label="Más personas"
                                    onClick={() => updateQuantity(lineKey(line), line.quantity + 1)}
                                    disabled={line.quantity >= line.slot.remaining}
                                  >
                                    <AddRounded fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
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
                    label="Nombre"
                    placeholder="Juan Pérez"
                    size="small"
                    required
                    value={customerName}
                    onChange={(e) => setCustomer({ name: e.target.value })}
                    error={customerName.length > 0 && !nameValid}
                    slotProps={{ inputLabel: { shrink: true } }}
                  />
                  <TextField
                    label="Teléfono"
                    placeholder="55 1234 5678"
                    size="small"
                    required
                    type="tel"
                    value={customerPhone}
                    onChange={(e) => setCustomer({ phone: e.target.value })}
                    error={customerPhone.length > 0 && !phoneValid}
                    slotProps={{ inputLabel: { shrink: true } }}
                    helperText={
                      customerPhone.length > 0 && !phoneValid
                        ? 'Ingresa un teléfono válido (10 dígitos).'
                        : 'Obligatorio — por aquí se envían los boletos por WhatsApp.'
                    }
                  />
                  <TextField
                    label="Correo electrónico (opcional)"
                    placeholder="cliente@correo.com"
                    size="small"
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomer({ email: e.target.value })}
                    error={emailTrimmed.length > 0 && !emailValid}
                    slotProps={{ inputLabel: { shrink: true } }}
                    helperText={
                      emailTrimmed.length > 0 && !emailValid
                        ? 'Ingresa un correo electrónico válido.'
                        : 'Opcional — copia del recibo y del boleto por correo.'
                    }
                  />
                </Stack>
            </SectionCard>

            <SectionCard
              title="Método de pago"
              action={
                <InfoPopover label="Cómo afecta el método de pago a tu caja">
                  <Stack spacing={1}>
                    <Box>
                      <b>Efectivo</b> entra a tu caja — lo entregas a la empresa en el corte.
                    </Box>
                    <Box>
                      <b>Transferencia</b> la cobra la empresa: no suma a tu caja (generas comisión
                      igual), y los boletos se envían cuando un administrador verifica el pago.
                    </Box>
                  </Stack>
                </InfoPopover>
              }
            >
                {/* US-AG41 (D1) — only Efectivo + Transferencia for now (card/link hidden). */}
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
                  <ToggleButton value="transfer" aria-label="Transferencia">
                    <AccountBalanceRounded fontSize="small" sx={{ mr: 1 }} />
                    Transferencia
                  </ToggleButton>
                </ToggleButtonGroup>

                {/* US-AG41 — a transfer requires its bank reference; the QR is held until verified. */}
                {paymentMethod === 'transfer' && (
                  <TextField
                    label="Referencia de la transferencia"
                    placeholder="Ej. BBVA 0099887766"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    error={reference.trim().length > 0 && !referenceValid}
                    helperText={
                      reference.trim().length > 0 && !referenceValid
                        ? 'Captura al menos 4 caracteres.'
                        : 'Número o folio del comprobante — el administrador lo verifica.'
                    }
                    fullWidth
                    sx={{ mt: 2 }}
                  />
                )}

                {/* Structured, at-a-glance consequence — flips with the selection. */}
                <Stack
                  direction="row"
                  spacing={0.75}
                  sx={{ alignItems: 'center', mt: 1.5, color: 'text.secondary' }}
                >
                  {paymentMethod === 'cash' ? (
                    <>
                      <SavingsRounded sx={{ fontSize: 18 }} />
                      <Typography variant="caption">Entra a tu caja</Typography>
                    </>
                  ) : (
                    <>
                      <HourglassTopRounded sx={{ fontSize: 18 }} />
                      <Typography variant="caption">
                        En verificación · los boletos se envían al confirmar el pago
                      </Typography>
                    </>
                  )}
                </Stack>
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
                  placeholder="0.00"
                  type="number"
                  fullWidth
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  error={saleState === 'INSUFFICIENT' || saleState === 'EXCESS'}
                  slotProps={{
                    inputLabel: { shrink: true },
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
              {(!nameValid || !phoneValid) && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', textAlign: 'center', mt: 1 }}
                >
                  Captura nombre y teléfono del cliente para enviar los boletos y cobrar.
                </Typography>
              )}
            </Box>
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
