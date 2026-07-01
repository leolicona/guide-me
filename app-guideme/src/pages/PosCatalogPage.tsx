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
  Snackbar,
} from '@mui/material'
import { datePillSx, filterStripSx } from '../features/filters'
import { MoneyText } from '../components'
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import { usePosServices } from '../features/pos/hooks'
import { AvailabilityChip } from '../features/pos/components/AvailabilityChip'
import { ServiceSheet } from '../features/pos/components/ServiceSheet'
import { LodgingStaySheet } from '../features/pos/components/LodgingStaySheet'
import { PosDatePickerSheet } from '../features/pos/components/PosDatePickerSheet'
import { PosCategorySheet } from '../features/pos/components/PosCategorySheet'
import { useTopBarActions } from '../layout/TopBarContext'
import { floatingControlSx } from '../layout/topBarStyles'
import { usePosCart, cartCount } from '../store/posCart'
import { usePosFilters } from '../store/posFilters'
import { usePosPreferences } from '../store/posPreferences'
import {
  categoryLabel,
  type ServiceCategory,
} from '../features/catalog/categories'
import { ROUTES } from '../config/routes'
// Org-local "today" (device-local calendar string, BUG-007) — the anchor for the default
// 3-day window and the floor for the date picker; shared with the sheet/detail views.
import { todayStr, addDays } from '../features/pos/dates'

const WEEKDAYS_ES = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB']
const MONTHS_ES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']

// "SÁB 14" — weekday + day-of-month for a YYYY-MM-DD string (UTC getters to match addDays).
const dayPillLabel = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()}`
}

// "VIE 27 JUN" — fuller label for the "Próximo" footer field (adds month for context).
const nextDateLabel = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_ES[d.getUTCMonth()]}`
}

export default function PosCatalogPage() {
  // US-AG30 — the selected day is global (inherited by the detail view); null = "Hoy"
  // (the default rolling 3-day window). The category chip stays local (resets on navigation);
  // hide-sold-out is a persisted preference from Settings.
  const selectedDate = usePosFilters((s) => s.selectedDate)
  const setSelectedDate = usePosFilters((s) => s.setSelectedDate)
  const today = todayStr()

  const { data: services, isLoading, isError } = usePosServices(
    today,
    selectedDate ?? undefined,
  )
  const count = usePosCart((s) => cartCount(s.lines))
  const navigate = useNavigate()

  // The cart lives in the layout-owned TopBar (a sibling of the account avatar), so it stays
  // fixed top-right and survives navigation. Re-syncs whenever the cart count changes.
  useTopBarActions(
    <Badge badgeContent={count} color="primary" overlap="circular">
      <IconButton
        aria-label="Carrito"
        component={RouterLink}
        to={ROUTES.POS_CHECKOUT}
        disabled={count === 0}
        sx={{ ...floatingControlSx, color: 'text.secondary', '&.Mui-disabled': { bgcolor: 'background.paper' } }}
      >
        <ShoppingCartRounded />
      </IconButton>
    </Badge>,
    [count],
  )

  const hideSoldOut = usePosPreferences((s) => s.hideSoldOut)
  const [activeCategory, setActiveCategory] = useState<ServiceCategory | null>(null)
  // US-AG31 — tapping a card opens this service in the Bottom Sheet (no navigation, the
  // catalog stays mounted). `added` drives the success Snackbar lifted up from the sheet.
  const [openServiceId, setOpenServiceId] = useState<string | null>(null)
  // US-AG36 — a lodging card opens the range-first stay sheet instead of the slot sheet.
  const [openLodging, setOpenLodging] = useState<{ id: string; name: string } | null>(null)
  const [added, setAdded] = useState(false)
  // US-AG35 — the calendar Bottom Sheet (any-day picker) toggles off this state.
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [categorySheetOpen, setCategorySheetOpen] = useState(false)

  // US-AG35 — the quick-day strip shows HOY (the anchor) + the next two days; any other day
  // is picked from the calendar. When the selection is outside the strip, the calendar
  // button itself goes active and shows the chosen date (so the selection is never hidden).
  const stripDays = [addDays(today, 1), addDays(today, 2)]
  const calendarActive = selectedDate !== null && !stripDays.includes(selectedDate)

  const all = services ?? []
  const byAvailability = hideSoldOut ? all.filter((s) => s.has_availability) : all
  const visibleServices =
    activeCategory === null
      ? byAvailability
      : byAvailability.filter((s) => s.category === activeCategory)

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
        Vender
      </Typography>

      <Fade in timeout={400}>
        <Box>
        {/* Single filter strip: quick-day picks + calendar opener + category sheet trigger.
            All chips share datePillSx — same height, radius, and active state. The 24px bottom
            margin (section gap) separates this control group from the service list below. */}
        <Box sx={{ ...filterStripSx, mb: 3 }}>
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
          <ButtonBase
            onClick={() => setCategorySheetOpen(true)}
            sx={datePillSx(activeCategory !== null)}
            aria-label="Filtrar por categoría"
          >
            {activeCategory ? categoryLabel(activeCategory) : 'Todos'}
          </ButtonBase>
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
              {visibleServices.map((service) => {
                const isLodgingCard = service.category === 'lodging'
                return (
                // Structure-first: the theme gives the card its hairline border + 16px radius
                // and no resting shadow — readable in any light (replaces the old soft-shadow).
                <Card key={service.id}>
                  <CardActionArea
                    onClick={() =>
                      isLodgingCard
                        ? setOpenLodging({ id: service.id, name: service.name })
                        : setOpenServiceId(service.id)
                    }
                    sx={{
                      height: '100%',
                      transition: 'transform 240ms ease',
                      '&:active': { transform: 'scale(0.99)' },
                    }}
                  >
                    <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
                      {/* Availability leads — the agent reads this before the name. */}
                      <AvailabilityChip available={service.has_availability} />

                      <Typography
                        component="h2"
                        sx={{
                          mt: 1,
                          fontSize: 22,
                          lineHeight: '30px',
                          fontWeight: 600,
                          letterSpacing: '-0.01em',
                        }}
                      >
                        {service.name}
                      </Typography>

                      {service.description && (
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            mt: 0.5,
                            fontWeight: 300,
                            lineHeight: 1.6,
                            display: '-webkit-box',
                            WebkitLineClamp: 1,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {service.description}
                        </Typography>
                      )}

                      <Box
                        sx={{
                          mt: 2,
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
                          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'baseline' }}>
                            <MoneyText
                              cents={isLodgingCard ? (service.from_nightly_rate ?? 0) : service.base_price}
                              variant="h3"
                              srLabel={`${service.name}, desde`}
                            />
                            {isLodgingCard && (
                              <Typography variant="body2" color="text.secondary">
                                / noche
                              </Typography>
                            )}
                          </Stack>
                        </Box>
                        {!isLodgingCard && service.next_slot_date && (
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
                              {nextDateLabel(service.next_slot_date)}
                            </Typography>
                          </Box>
                        )}
                      </Box>
                    </CardContent>
                  </CardActionArea>
                </Card>
                )
              })}
            </Stack>
          ))}

        </Box>
      </Fade>

      <PosCategorySheet
        open={categorySheetOpen}
        onClose={() => setCategorySheetOpen(false)}
        activeCategory={activeCategory}
        onPick={(c) => setActiveCategory(c)}
      />

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

      {/* US-AG36 — lodging range-first stay sheet. */}
      <LodgingStaySheet
        service={openLodging}
        onClose={() => setOpenLodging(null)}
        onAdded={() => {
          setOpenLodging(null)
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
  )
}
