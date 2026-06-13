import { useState } from 'react'
import { useNavigate, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Badge,
  Chip,
  TextField,
  FormControlLabel,
  Switch,
  Snackbar,
  useMediaQuery,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded'
import { usePosServices } from '../features/pos/hooks'
import { AvailabilityChip } from '../features/pos/components/AvailabilityChip'
import { ServiceSheet } from '../features/pos/components/ServiceSheet'
import { AccountAvatarChip } from '../layout/AccountAvatarChip'
import { usePosCart, cartCount } from '../store/posCart'
import { usePosFilters } from '../store/posFilters'
import { formatMoney } from '../features/catalog/types'
import {
  SERVICE_CATEGORIES,
  categoryLabel,
  type ServiceCategory,
} from '../features/catalog/categories'
import { ROUTES } from '../config/routes'
// Org-local "today" (device-local calendar string, BUG-007) — the anchor for the default
// 3-day window and the floor for the date picker; shared with the sheet/detail views.
import { todayStr } from '../features/pos/dates'

export default function PosCatalogPage() {
  // US-AG30 — the selected day is global (inherited by the detail view); null = "Hoy"
  // (the default rolling 3-day window). The hide-sold-out toggle and category chip stay
  // local — they reset on navigation.
  const selectedDate = usePosFilters((s) => s.selectedDate)
  const setSelectedDate = usePosFilters((s) => s.setSelectedDate)
  const today = todayStr()

  // On mobile the account avatar lives inline in this page's top bar (a Cart sibling); on
  // desktop it lives in the rail, so the bar shows only the Cart.
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))

  const { data: services, isLoading, isError } = usePosServices(
    today,
    selectedDate ?? undefined,
  )
  const count = usePosCart((s) => cartCount(s.lines))
  const navigate = useNavigate()

  const [hideSoldOut, setHideSoldOut] = useState(true)
  const [activeCategory, setActiveCategory] = useState<ServiceCategory | null>(null)
  // US-AG31 — tapping a card opens this service in the Bottom Sheet (no navigation, the
  // catalog stays mounted). `added` drives the success Snackbar lifted up from the sheet.
  const [openServiceId, setOpenServiceId] = useState<string | null>(null)
  const [added, setAdded] = useState(false)

  // Filter precedence (all client-side over the loaded list): hide-sold-out → derive the
  // present categories from what survives → category chip → render grid. Deriving the chip
  // set from the availability-filtered list keeps US-A37's promise (a chip only for a
  // category with ≥ 1 available service) honest while the toggle is on.
  const all = services ?? []
  const byAvailability = hideSoldOut ? all.filter((s) => s.has_availability) : all
  const presentCategories = SERVICE_CATEGORIES.filter((c) =>
    byAvailability.some((s) => s.category === c),
  )
  const visibleServices =
    activeCategory === null
      ? byAvailability
      : byAvailability.filter((s) => s.category === activeCategory)

  return (
    <Fade in timeout={400}>
      <Box>
        {/* Title removed (US-UX02 — the bottom nav already names the active view). The bar is a
            right-aligned cluster: Cart + (on mobile) the account avatar as flowed siblings. */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            minHeight: 56,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
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
            {!isDesktop && <AccountAvatarChip inline />}
          </Box>
        </Box>

        {/* US-AG30 — filter bar: Date (default "Hoy") + "Ocultar agotados" toggle. */}
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ mt: 1, mb: 2, flexWrap: 'wrap', rowGap: 1.5, alignItems: 'center' }}
        >
          <Chip
            label="Hoy"
            color={selectedDate === null ? 'secondary' : 'default'}
            variant={selectedDate === null ? 'filled' : 'outlined'}
            onClick={() => setSelectedDate(null)}
          />
          <TextField
            type="date"
            size="small"
            label="Fecha"
            value={selectedDate ?? ''}
            onChange={(e) => setSelectedDate(e.target.value || null)}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { min: today },
            }}
          />
          <Box sx={{ flexGrow: 1 }} />
          <FormControlLabel
            control={
              <Switch
                checked={hideSoldOut}
                onChange={(e) => setHideSoldOut(e.target.checked)}
              />
            }
            label="Ocultar agotados"
          />
        </Stack>

        {/* US-A37 — category chips, derived from the availability-filtered set. */}
        {presentCategories.length > 0 && (
          <Stack
            direction="row"
            spacing={1}
            sx={{ mb: 3, flexWrap: 'wrap', rowGap: 1 }}
          >
            <Chip
              label="Todos"
              color={activeCategory === null ? 'secondary' : 'default'}
              variant={activeCategory === null ? 'filled' : 'outlined'}
              onClick={() => setActiveCategory(null)}
            />
            {presentCategories.map((c) => (
              <Chip
                key={c}
                label={categoryLabel(c)}
                color={activeCategory === c ? 'secondary' : 'default'}
                variant={activeCategory === c ? 'filled' : 'outlined'}
                onClick={() =>
                  setActiveCategory((prev) => (prev === c ? null : c))
                }
              />
            ))}
          </Stack>
        )}

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudieron cargar los servicios. Por favor, inténtalo de nuevo.</Alert>
        )}

        {services &&
          (visibleServices.length === 0 ? (
            <Typography color="text.secondary">
              No hay servicios disponibles en este momento.
            </Typography>
          ) : (
            <Box
              sx={{
                display: 'grid',
                gap: 2,
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              }}
            >
              {visibleServices.map((service) => (
                <Card key={service.id}>
                  <CardActionArea
                    onClick={() => setOpenServiceId(service.id)}
                    sx={{ height: '100%' }}
                  >
                    <CardContent>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                      >
                        <Typography variant="h6" component="h2" sx={{ minWidth: 0 }}>
                          {service.name}
                        </Typography>
                        <AvailabilityChip available={service.has_availability} />
                      </Stack>
                      {service.description && (
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ mt: 1 }}
                        >
                          {service.description}
                        </Typography>
                      )}
                      <Typography variant="body2" sx={{ mt: 1.5, fontWeight: 500 }}>
                        desde {formatMoney(service.base_price)}
                      </Typography>
                      {service.next_slot_date && (
                        <Typography variant="caption" color="text.secondary">
                          Próximo: {service.next_slot_date}
                        </Typography>
                      )}
                    </CardContent>
                  </CardActionArea>
                </Card>
              ))}
            </Box>
          ))}

        {/* US-AG31 — Bottom Sheet for fast sale config; closes + snackbars on add. */}
        <ServiceSheet
          serviceId={openServiceId}
          onClose={() => setOpenServiceId(null)}
          onAdded={() => {
            setOpenServiceId(null)
            setAdded(true)
          }}
        />

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
