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
      slot,
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
            Services
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
          <Alert severity="error">Couldn't load this service. Please try again.</Alert>
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
                {formatMoney(service.base_price)} · min{' '}
                {formatMoney(service.minimum_price)}
              </Typography>
            </Box>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  Choose a time
                </Typography>
                <SlotPicker
                  slots={service.slots}
                  selectedId={slot?.id ?? null}
                  onSelect={handleSelectSlot}
                />
              </CardContent>
            </Card>

            {slot && (
              <Card>
                <CardContent>
                  <Stack spacing={3}>
                    <Box>
                      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                        People
                      </Typography>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <IconButton
                          size="small"
                          aria-label="Fewer people"
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
                          aria-label="More people"
                          onClick={() =>
                            setQuantity((q) => Math.min(slot.remaining, q + 1))
                          }
                          disabled={quantity >= slot.remaining}
                        >
                          <AddRounded />
                        </IconButton>
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                          {slot.remaining} available
                        </Typography>
                      </Stack>
                    </Box>

                    <Box>
                      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                        Unit price
                      </Typography>
                      <TextField
                        type="number"
                        size="small"
                        value={priceInput}
                        onChange={(e) => setPriceInput(e.target.value)}
                        error={priceInput !== '' && priceInvalid}
                        helperText={
                          belowMin
                            ? `Minimum ${formatMoney(service.minimum_price)}`
                            : aboveBase
                              ? `Maximum ${formatMoney(service.base_price)}`
                              : `Min ${formatMoney(service.minimum_price)} · base ${formatMoney(service.base_price)}`
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
                                    aria-label={`Fewer ${extra.name}`}
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
                                    aria-label={`More ${extra.name}`}
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
                      Add to cart
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
                View cart
              </Button>
            }
          >
            Added to cart
          </Alert>
        </Snackbar>
      </Box>
    </Fade>
  )
}
