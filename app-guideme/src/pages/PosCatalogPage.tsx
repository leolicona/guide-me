import { useState } from 'react'
import { useNavigate, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  IconButton,
  ButtonBase,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Badge,
  FormControlLabel,
  Switch,
  Snackbar,
  useMediaQuery,
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import type { SxProps, Theme } from '@mui/material/styles'
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import { usePosServices } from '../features/pos/hooks'
import { AvailabilityChip } from '../features/pos/components/AvailabilityChip'
import { ServiceSheet } from '../features/pos/components/ServiceSheet'
import { PosDatePickerSheet } from '../features/pos/components/PosDatePickerSheet'
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
import { todayStr, addDays } from '../features/pos/dates'

const WEEKDAYS_ES = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB']

// "SÁB 14" — weekday + day-of-month for a YYYY-MM-DD string (UTC getters to match addDays).
const dayPillLabel = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()}`
}

// A tall rounded date pill (Luminous): filled Indigo when active, hairline-bordered surface
// otherwise.
const datePillSx = (active: boolean): SxProps<Theme> => ({
  flexShrink: 0,
  height: 48,
  px: 2,
  gap: 1,
  borderRadius: '0.75rem',
  fontSize: 13,
  fontWeight: active ? 600 : 500,
  letterSpacing: '0.01em',
  whiteSpace: 'nowrap',
  transition: 'background-color 160ms ease, color 160ms ease',
  color: active ? 'primary.contrastText' : 'text.secondary',
  bgcolor: active ? 'primary.main' : 'background.paper',
  border: active ? '1px solid transparent' : '1px solid',
  borderColor: active ? 'transparent' : 'divider',
  '&:hover': {
    bgcolor: active ? 'primary.main' : 'action.hover',
  },
})

// A short pill-shaped category chip: a soft Indigo tint when active, hairline surface
// otherwise (rounded-full, Luminous low-saturation accent).
const categoryPillSx = (active: boolean): SxProps<Theme> => ({
  flexShrink: 0,
  height: 36,
  px: 2,
  borderRadius: 999,
  fontSize: 13,
  fontWeight: active ? 600 : 500,
  whiteSpace: 'nowrap',
  transition: 'background-color 160ms ease, color 160ms ease',
  color: active ? 'primary.main' : 'text.secondary',
  bgcolor: (t: Theme) =>
    active ? alpha(t.palette.primary.main, 0.1) : t.palette.background.paper,
  border: active ? '1px solid transparent' : '1px solid',
  borderColor: active ? 'transparent' : 'divider',
  '&:hover': {
    bgcolor: (t: Theme) =>
      active ? alpha(t.palette.primary.main, 0.16) : t.palette.action.hover,
  },
})

// A horizontally scrollable strip that bleeds to the screen edge on mobile (so the first/last
// pill can sit flush) and hides its scrollbar.
const stripSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  overflowX: 'auto',
  py: 0.5,
  mx: { xs: -2, md: 0 },
  px: { xs: 2, md: 0 },
  scrollbarWidth: 'none',
  '&::-webkit-scrollbar': { display: 'none' },
}

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
  // US-AG35 — the calendar Bottom Sheet (any-day picker) toggles off this state.
  const [datePickerOpen, setDatePickerOpen] = useState(false)

  // US-AG35 — the quick-day strip shows HOY (the anchor) + the next two days; any other day
  // is picked from the calendar. When the selection is outside the strip, the calendar
  // button itself goes active and shows the chosen date (so the selection is never hidden).
  const stripDays = [addDays(today, 1), addDays(today, 2)]
  const calendarActive = selectedDate !== null && !stripDays.includes(selectedDate)

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
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        {/* Top app bar: the view title (US-UX02 names it here, matching the Luminous mockup)
            + a right cluster of Cart and — on mobile — the account avatar. */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            minHeight: 56,
            mb: 1,
          }}
        >
          <Typography
            component="h1"
            sx={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}
          >
            Vender
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Badge badgeContent={count} color="primary" overlap="circular">
              <IconButton
                aria-label="Carrito"
                component={RouterLink}
                to={ROUTES.POS_CHECKOUT}
                disabled={count === 0}
                sx={{ color: 'text.secondary' }}
              >
                <ShoppingCartRounded />
              </IconButton>
            </Badge>
            {!isDesktop && <AccountAvatarChip inline />}
          </Box>
        </Box>

        {/* US-AG35 — quick-day strip: HOY (anchor) + the next two days + a calendar button
            opening the month picker (Bottom Sheet). */}
        <Box sx={stripSx}>
          <ButtonBase
            onClick={() => setSelectedDate(null)}
            sx={datePillSx(selectedDate === null)}
          >
            HOY
          </ButtonBase>
          {stripDays.map((d) => (
            <ButtonBase
              key={d}
              onClick={() => setSelectedDate(d)}
              sx={datePillSx(selectedDate === d)}
            >
              {dayPillLabel(d)}
            </ButtonBase>
          ))}
          <ButtonBase
            onClick={() => setDatePickerOpen(true)}
            sx={datePillSx(calendarActive)}
            aria-label="Abrir calendario"
          >
            <CalendarMonthRounded sx={{ fontSize: 20 }} />
            {calendarActive && selectedDate && dayPillLabel(selectedDate)}
          </ButtonBase>
        </Box>

        {/* US-A37 — category pills, derived from the availability-filtered set. */}
        {presentCategories.length > 0 && (
          <Box sx={{ ...stripSx, mt: 0.5 }}>
            <ButtonBase
              onClick={() => setActiveCategory(null)}
              sx={categoryPillSx(activeCategory === null)}
            >
              Todos
            </ButtonBase>
            {presentCategories.map((c) => (
              <ButtonBase
                key={c}
                onClick={() => setActiveCategory((prev) => (prev === c ? null : c))}
                sx={categoryPillSx(activeCategory === c)}
              >
                {categoryLabel(c)}
              </ButtonBase>
            ))}
          </Box>
        )}

        {/* Sold-out toggle — kept (the catalog defaults to hiding agotados), placed subtly to
            preserve the minimalist strip above. */}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5, mb: 2 }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={hideSoldOut}
                onChange={(e) => setHideSoldOut(e.target.checked)}
              />
            }
            label={
              <Typography variant="body2" color="text.secondary">
                Ocultar agotados
              </Typography>
            }
          />
        </Box>

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
            <Stack spacing={2}>
              {visibleServices.map((service) => (
                <Card
                  key={service.id}
                  sx={{
                    borderRadius: 2,
                    border: '1px solid',
                    borderColor: alpha('#000', 0.04),
                    boxShadow:
                      '0 4px 24px -4px rgba(0,0,0,0.03), 0 2px 8px -2px rgba(0,0,0,0.02)',
                  }}
                >
                  <CardActionArea
                    onClick={() => setOpenServiceId(service.id)}
                    sx={{
                      height: '100%',
                      transition: 'transform 240ms ease',
                      '&:active': { transform: 'scale(0.99)' },
                    }}
                  >
                    <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
                      <Stack
                        direction="row"
                        spacing={1.5}
                        sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                      >
                        <Typography
                          component="h2"
                          sx={{
                            minWidth: 0,
                            fontSize: 22,
                            lineHeight: '30px',
                            fontWeight: 600,
                            letterSpacing: '-0.01em',
                          }}
                        >
                          {service.name}
                        </Typography>
                        <AvailabilityChip available={service.has_availability} />
                      </Stack>

                      {service.description && (
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            mt: 1,
                            fontWeight: 300,
                            lineHeight: 1.6,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {service.description}
                        </Typography>
                      )}

                      <Box
                        sx={{
                          mt: 2.5,
                          pt: 2,
                          borderTop: '1px solid',
                          borderColor: 'divider',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-end',
                        }}
                      >
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                          <Typography
                            sx={{
                              fontSize: 10,
                              fontWeight: 600,
                              letterSpacing: '0.08em',
                              textTransform: 'uppercase',
                              color: 'text.secondary',
                            }}
                          >
                            Desde
                          </Typography>
                          <Typography
                            sx={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}
                          >
                            {formatMoney(service.base_price)}
                          </Typography>
                        </Box>
                        {service.next_slot_date && (
                          <Box
                            sx={{
                              textAlign: 'right',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 0.5,
                            }}
                          >
                            <Typography
                              sx={{
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: '0.08em',
                                textTransform: 'uppercase',
                                color: 'text.secondary',
                              }}
                            >
                              Próximo
                            </Typography>
                            <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
                              {service.next_slot_date}
                            </Typography>
                          </Box>
                        )}
                      </Box>
                    </CardContent>
                  </CardActionArea>
                </Card>
              ))}
            </Stack>
          ))}

        {/* US-AG35 — calendar Bottom Sheet (any-day picker). Picking a day scopes the catalog
            to it; "Hoy" clears back to the default window. */}
        <PosDatePickerSheet
          open={datePickerOpen}
          onClose={() => setDatePickerOpen(false)}
          selectedDate={selectedDate}
          today={today}
          onPick={(d) => {
            setSelectedDate(d)
            setDatePickerOpen(false)
          }}
          onClearToToday={() => {
            setSelectedDate(null)
            setDatePickerOpen(false)
          }}
        />

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
