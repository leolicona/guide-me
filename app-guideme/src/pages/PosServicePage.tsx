import { useState } from 'react'
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom'
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
  TextField,
  IconButton,
  Badge,
  Snackbar,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import RemoveRounded from '@mui/icons-material/RemoveRounded'
import { usePosService } from '../features/pos/hooks'
import { SlotPicker } from '../features/pos/components/SlotPicker'
import { effectiveRemaining } from '../features/pos/capacity'
import type { PosSlot } from '../features/pos/types'
import { usePosCart, cartCount, type CartExtra } from '../store/posCart'
import {
  amountToCents,
  centsToAmount,
  formatMoney,
} from '../features/catalog/types'
import { ROUTES } from '../config/routes'

export default function PosServicePage() {
  const { id } = useParams<{ id: string }>()
  const { data: service, isLoading, isError } = usePosService(id)
  const navigate = useNavigate()

  const addLine = usePosCart((s) => s.addLine)
  const count = usePosCart((s) => cartCount(s.lines))

  const [slot, setSlot] = useState<PosSlot | null>(null)
  const [quantity, setQuantity] = useState(1)
  // Discount price is edited in major units; clamped to [minimum, base].
  const [priceInput, setPriceInput] = useState('')
  const [extraQtys, setExtraQtys] = useState<Record<string, number>>({})
  const [added, setAdded] = useState(false)

  const resetSelection = () => {
    setSlot(null)
    setQuantity(1)
    setPriceInput('')
    setExtraQtys({})
  }

  const handleSelectSlot = (s: PosSlot) => {
    setSlot(s)
    setQuantity(1)
    if (service) setPriceInput(String(centsToAmount(service.base_price)))
  }

  const handleAdd = () => {
    if (!service || !slot) return
    const unitCents = amountToCents(Number(priceInput))
    const extras: CartExtra[] = service.extras
      .filter((e) => (extraQtys[e.id] ?? 0) > 0)
      .map((e) => ({ extra: e, quantity: extraQtys[e.id] }))

    addLine({
      service: {
        id: service.id,
        name: service.name,
        base_price: service.base_price,
        minimum_price: service.minimum_price,
      },
      // US-A36 — the cart caps quantity at `remaining`; for a Soft Cap service that ceiling
      // is the Effective Capacity (raw + flexible margin), so pass the effective figure.
      slot: { ...slot, remaining: flexRemaining },
      quantity,
      unit_price: unitCents,
      extras,
    })
    resetSelection()
    setAdded(true)
  }

  // Discount-field validation (the store also clamps; this drives inline UX).
  const priceCents = priceInput === '' ? NaN : amountToCents(Number(priceInput))
  const belowMin = service ? priceCents < service.minimum_price : false
  const aboveBase = service ? priceCents > service.base_price : false
  const priceInvalid = Number.isNaN(priceCents) || belowMin || aboveBase

  // US-A36 — the sellable ceiling for the selected slot: raw remaining for a Hard Cap
  // service, raw + flexible margin for a Soft Cap one. `inFlexZone` is true once the counter
  // crosses the strict capacity into the overbooking margin, so the UI can flag it.
  const flexRemaining =
    service && slot
      ? effectiveRemaining(slot, service.is_flexible, service.flex_capacity_pct)
      : (slot?.remaining ?? 0)
  const inFlexZone = !!slot && quantity > slot.remaining

  return (
    <Fade in timeout={400}>
      <Box>
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 2,
          }}
        >
          <Button component={RouterLink} to={ROUTES.POS} startIcon={<ArrowBackRounded />}>
            Servicios
          </Button>
          <Badge badgeContent={count} color="secondary">
            <Button
              variant="outlined"
              startIcon={<ShoppingCartRounded />}
              component={RouterLink}
              to={ROUTES.POS_CHECKOUT}
              disabled={count === 0}
            >
              Cart
            </Button>
          </Badge>
        </Box>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudo cargar este servicio. Por favor, inténtalo de nuevo.</Alert>
        )}

        {service && (
          <Stack spacing={3}>
            <Box>
              <Typography variant="h5" component="h1">
                {service.name}
              </Typography>
              {service.description && (
                <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                  {service.description}
                </Typography>
              )}
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {formatMoney(service.base_price)} · mín{' '}
                {formatMoney(service.minimum_price)}
              </Typography>
            </Box>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  Elige un horario
                </Typography>
                <SlotPicker
                  slots={service.slots}
                  selectedId={slot?.id ?? null}
                  onSelect={handleSelectSlot}
                  isFlexible={service.is_flexible}
                  flexCapacityPct={service.flex_capacity_pct}
                />
              </CardContent>
            </Card>

            {slot && (
              <Card>
                <CardContent>
                  <Stack spacing={3}>
                    <Box>
                      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                        Personas
                      </Typography>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <IconButton
                          size="small"
                          aria-label="Menos personas"
                          onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                          disabled={quantity <= 1}
                        >
                          <RemoveRounded />
                        </IconButton>
                        <Typography sx={{ minWidth: 32, textAlign: 'center' }}>
                          {quantity}
                        </Typography>
                        <IconButton
                          size="small"
                          aria-label="Más personas"
                          onClick={() =>
                            setQuantity((q) => Math.min(flexRemaining, q + 1))
                          }
                          disabled={quantity >= flexRemaining}
                        >
                          <AddRounded />
                        </IconButton>
                        <Typography
                          variant="caption"
                          color={inFlexZone ? 'warning.main' : 'text.secondary'}
                          sx={{ ml: 1, fontWeight: inFlexZone ? 600 : 400 }}
                        >
                          {inFlexZone
                            ? `Usando cupo flexible · ${flexRemaining} máx.`
                            : `${slot.remaining} disponibles`}
                        </Typography>
                      </Stack>
                    </Box>

                    <Box>
                      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                        Precio unitario
                      </Typography>
                      <TextField
                        type="number"
                        size="small"
                        value={priceInput}
                        onChange={(e) => setPriceInput(e.target.value)}
                        error={priceInput !== '' && priceInvalid}
                        helperText={
                          belowMin
                            ? `Mínimo ${formatMoney(service.minimum_price)}`
                            : aboveBase
                              ? `Máximo ${formatMoney(service.base_price)}`
                              : `Mín ${formatMoney(service.minimum_price)} · base ${formatMoney(service.base_price)}`
                        }
                        slotProps={{
                          htmlInput: {
                            min: centsToAmount(service.minimum_price),
                            max: centsToAmount(service.base_price),
                            step: 0.01,
                          },
                        }}
                      />
                    </Box>

                    {service.extras.length > 0 && (
                      <Box>
                        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                          Extras
                        </Typography>
                        <Stack spacing={1} divider={<Divider flexItem />}>
                          {service.extras.map((extra) => {
                            const qty = extraQtys[extra.id] ?? 0
                            return (
                              <Stack
                                key={extra.id}
                                direction="row"
                                spacing={1}
                                sx={{ alignItems: 'center', justifyContent: 'space-between' }}
                              >
                                <Box sx={{ minWidth: 0 }}>
                                  <Typography variant="body2">{extra.name}</Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    {formatMoney(extra.price)}
                                  </Typography>
                                </Box>
                                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                                  <IconButton
                                    size="small"
                                    aria-label={`Menos ${extra.name}`}
                                    onClick={() =>
                                      setExtraQtys((m) => ({
                                        ...m,
                                        [extra.id]: Math.max(0, qty - 1),
                                      }))
                                    }
                                    disabled={qty <= 0}
                                  >
                                    <RemoveRounded fontSize="small" />
                                  </IconButton>
                                  <Typography sx={{ minWidth: 24, textAlign: 'center' }}>
                                    {qty}
                                  </Typography>
                                  <IconButton
                                    size="small"
                                    aria-label={`Más ${extra.name}`}
                                    onClick={() =>
                                      setExtraQtys((m) => ({
                                        ...m,
                                        [extra.id]: qty + 1,
                                      }))
                                    }
                                  >
                                    <AddRounded fontSize="small" />
                                  </IconButton>
                                </Stack>
                              </Stack>
                            )
                          })}
                        </Stack>
                      </Box>
                    )}

                    <Button
                      variant="contained"
                      disableElevation
                      onClick={handleAdd}
                      disabled={priceInvalid}
                    >
                      Agregar al carrito
                    </Button>
                  </Stack>
                </CardContent>
              </Card>
            )}
          </Stack>
        )}

        <Snackbar
          open={added}
          autoHideDuration={2500}
          onClose={() => setAdded(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            severity="success"
            variant="filled"
            onClose={() => setAdded(false)}
            action={
              <Button
                color="inherit"
                size="small"
                onClick={() => navigate(ROUTES.POS_CHECKOUT)}
              >
                Ver carrito
              </Button>
            }
          >
            Agregado al carrito
          </Alert>
        </Snackbar>
      </Box>
    </Fade>
  )
}
