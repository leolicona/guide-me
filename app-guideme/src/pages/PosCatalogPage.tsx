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
import { filterChipSx, filterStripSx } from '../features/filters'
import { MoneyText } from '../components'
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import { usePosServices } from '../features/pos/hooks'
import { AvailabilityChip } from '../features/pos/components/AvailabilityChip'
import { ServiceSheet } from '../features/pos/components/ServiceSheet'
import { LodgingStaySheet } from '../features/pos/components/LodgingStaySheet'
import { PosDatePickerSheet } from '../features/pos/components/PosDatePickerSheet'
import { useTopBarActions } from '../layout/TopBarContext'
import { floatingControlSx } from '../layout/topBarStyles'
import { usePosCart, cartCount } from '../store/posCart'
import { usePosFilters } from '../store/posFilters'
import { usePosPreferences } from '../store/posPreferences'
import {
  SERVICE_CATEGORIES,
  categoryLabel,
  type ServiceCategory,
} from '../features/catalog/categories'
import { ROUTES } from '../config/routes'
// Org-local "today" (device-local calendar string, BUG-007) — the anchor for the default
// week context and the floor for the date picker; shared with the sheet/detail views.
import { todayStr, contextPills } from '../features/pos/dates'

const WEEKDAYS_ES = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB']
const MONTHS_ES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']

// "SÁB 14" — weekday + day-of-month for a YYYY-MM-DD string (UTC getters to match addDays).
const dayPillLabel = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()}`
}

// "9–12 JUL" (same month) or "29 JUN – 2 JUL" — compact span for the calendar button.
const rangePillLabel = (from: string, to: string): string => {
  const a = new Date(`${from}T00:00:00Z`)
  const b = new Date(`${to}T00:00:00Z`)
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS_ES[b.getUTCMonth()]}`
    : `${a.getUTCDate()} ${MONTHS_ES[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS_ES[b.getUTCMonth()]}`
}

// "VIE 27 JUN" — fuller label for the "Próximo" footer field (adds month for context).
const nextDateLabel = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_ES[d.getUTCMonth()]}`
}

export default function PosCatalogPage() {
  // US-AG30/AG35 — the selection is global (inherited by the detail view); null = no explicit
  // pick → the contextual default week. The category chips stay local (reset on navigation);
  // hide-sold-out is a persisted preference from Settings.
  const selection = usePosFilters((s) => s.selection)
  const setSelection = usePosFilters((s) => s.setSelection)
  const today = todayStr()

  // US-AG35 — when no explicit selection is made, the catalog defaults to the contextual week
  // (today → Sunday). The date filter is picked from the calendar sheet; the week is the anchor.
  const defaultWeek = contextPills(today)[0]
  const effective = selection ?? { from: defaultWeek.from, to: defaultWeek.to }

  const { data: services, isLoading, isError } = usePosServices(
    today,
    effective.from,
    effective.to ?? effective.from,
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
  // US-A37 — multi-select category filter: empty = "Todos" (no filter); the catalog shows the
  // union of the selected categories and the calendar dots scope to the same set.
  const [activeCategories, setActiveCategories] = useState<ServiceCategory[]>([])
  const toggleCategory = (c: ServiceCategory) =>
    setActiveCategories((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    )
  // US-AG31 — tapping a card opens this service in the Bottom Sheet (no navigation, the
  // catalog stays mounted). `added` drives the success Snackbar lifted up from the sheet.
  const [openServiceId, setOpenServiceId] = useState<string | null>(null)
  // US-AG36 — a lodging card opens the range-first stay sheet instead of the slot sheet.
  const [openLodging, setOpenLodging] = useState<{ id: string; name: string } | null>(null)
  const [added, setAdded] = useState(false)
  // US-AG35 — the calendar Bottom Sheet (single-day or range picker) toggles off this state.
  const [datePickerOpen, setDatePickerOpen] = useState(false)

  const all = services ?? []
  const byAvailability = hideSoldOut ? all.filter((s) => s.has_availability) : all
  const visibleServices =
    activeCategories.length === 0
      ? byAvailability
      : byAvailability.filter(
          (s) => s.category !== null && activeCategories.includes(s.category),
        )

  // US-A37 — a category chip renders only for a category present in the current catalog.
  const presentCategories = SERVICE_CATEGORIES.filter((c) =>
    all.some((s) => s.category === c),
  )

  // The calendar button lights up (and shows the picked day/range) whenever there's an explicit
  // selection; the default contextual week leaves it in its resting state.
  const calendarSelection = selection

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
        Vender
      </Typography>

      <Fade in timeout={400}>
        <Box>
        {/* US-AG35 — Inline Filter Strip: multi-select category chips + a calendar button,
            all in one horizontally scrollable row (the calendar scrolls with the chips). The
            24px bottom margin separates this control group from the service list below. */}
        <Box sx={{ ...filterStripSx, mb: 3 }}>
          {/* Category chips — "Todas" clears the filter; each category toggles (US-A37). */}
          <ButtonBase
            onClick={() => setActiveCategories([])}
            sx={filterChipSx(activeCategories.length === 0)}
          >
            Todas
          </ButtonBase>
          {presentCategories.map((c) => (
            <ButtonBase
              key={c}
              onClick={() => toggleCategory(c)}
              sx={filterChipSx(activeCategories.includes(c))}
            >
              {categoryLabel(c)}
            </ButtonBase>
          ))}

          {/* Calendar button — opens the sheet; shows any explicit day/range pick. */}
          <ButtonBase
            onClick={() => setDatePickerOpen(true)}
            sx={filterChipSx(calendarSelection !== null)}
            aria-label="Abrir calendario"
          >
            <CalendarMonthRounded sx={{ fontSize: 20 }} />
            {calendarSelection &&
              (calendarSelection.to
                ? rangePillLabel(calendarSelection.from, calendarSelection.to)
                : dayPillLabel(calendarSelection.from))}
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

      {/* US-AG35 — calendar Bottom Sheet: single-day or range picker. Picking scopes the catalog. */}
      <PosDatePickerSheet
        open={datePickerOpen}
        onClose={() => setDatePickerOpen(false)}
        selectedDate={selection?.from ?? null}
        dateRange={selection?.to ? { from: selection.from, to: selection.to } : null}
        today={today}
        categories={activeCategories}
        onPickDay={(d) => {
          setSelection({ from: d })
          setDatePickerOpen(false)
        }}
        onPickRange={(r) => {
          setSelection(r)
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
        initialRange={
          selection?.to
            ? { check_in: selection.from, check_out: selection.to }
            : null
        }
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
