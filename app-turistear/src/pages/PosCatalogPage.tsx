import { useState } from 'react'
import { useNavigate, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  IconButton,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Chip,
  Badge,
  Snackbar,
} from '@mui/material'
import { ClearableFilterChip, filterStripSx } from '../features/filters'
import { MoneyText } from '../components'
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded'
import BoltRounded from '@mui/icons-material/BoltRounded'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import TuneRounded from '@mui/icons-material/TuneRounded'
import { usePosServices } from '../features/pos/hooks'
import { AvailabilityChip } from '../features/pos/components/AvailabilityChip'
import { ServiceSheet } from '../features/pos/components/ServiceSheet'
import { PosCategorySheet } from '../features/pos/components/PosCategorySheet'
import {
  LodgingStaySheet,
  type LodgingStayTarget,
} from '../features/pos/components/LodgingStaySheet'
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
import { useMyOrganization } from '../features/organization'

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

// The resting label of the calendar chip — the name of the default window. `contextPills(today)[0]`
// is ALWAYS `(hoy → domingo próximo)`: both branches compute the same `comingSunday`, only the
// (never-rendered) internal key flips esta_semana/este_fin by weekday. So one static word is true
// all seven days. On a Sunday the span collapses to today alone — not a lie: the week has one day
// left. Naming it here is what stops the default from being an invisible state.
const DEFAULT_RANGE_LABEL = 'Esta semana'

// The resting label of the category chip. It names the AXIS, not the state, because "Todas" is
// already the sheet's word for the empty selection (PosCategorySheet) — reusing it out here would
// give one word two jobs one tap apart. Paired with DEFAULT_RANGE_LABEL the strip reads as a
// sentence at rest ("Categorías · Esta semana") instead of two mute icons.
const DEFAULT_CATEGORY_LABEL = 'Categorías'

// The category chip's label: the default axis name, one category by name, or the first + a "+N"
// overflow. "Tours +1" beats "2 categorías" — it keeps a real name on the chip, so the agent reads
// WHAT is filtered rather than only how many. The first is taken in SERVICE_CATEGORIES order, not
// tap order, so the same selection always renders the same label however it was assembled.
const categoryChipLabel = (active: ServiceCategory[]): string => {
  if (active.length === 0) return DEFAULT_CATEGORY_LABEL
  const [first, ...rest] = SERVICE_CATEGORIES.filter((c) => active.includes(c))
  return rest.length === 0 ? categoryLabel(first) : `${categoryLabel(first)} +${rest.length}`
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
  // US-A66 — anchor "today" to the org's time zone (not the device's), so every agent shares the
  // same catalog day. Falls back to device-local until the org loads.
  const { data: org } = useMyOrganization()
  const today = todayStr(org?.timezone)

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
  // catalog stays mounted). We carry the card's `next_slot_date` so the sheet can open on the
  // service's next available departure (US-AG33) without touching the global filter. `added`
  // drives the success Snackbar lifted up from the sheet.
  const [openService, setOpenService] = useState<{
    id: string
    nextSlotDate: string | null
  } | null>(null)
  // US-AG36 (v2) — a unit-type card opens the type-centric stay sheet instead of the slot sheet.
  const [openLodging, setOpenLodging] = useState<LodgingStayTarget | null>(null)
  // US-AG45 — the ⚡ opens the SAME sheet in express mode (today-only, phone-only, cash).
  const [expressServiceId, setExpressServiceId] = useState<string | null>(null)
  const [added, setAdded] = useState(false)
  // US-AG35 — the calendar Bottom Sheet (single-day or range picker) toggles off this state.
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  // US-A37 — the category filter now lives in its own Bottom Sheet (opened from the strip icon).
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)

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
        {/* US-AG35/A37 — Filter Strip: a category-filter button (opens the category Bottom Sheet)
            beside the calendar button. Both are ClearableFilterChip at the SAME 48px height; each
            shows its active selection inline, carries its own ✕ to drop it, and NAMES its default
            when there is no selection — so the strip always states the catalog's scope rather than
            leaving "no filter" as a mute icon. The 24px bottom margin separates this control group
            from the service list below. */}
        <Box sx={{ ...filterStripSx, mb: 3 }}>
          {/* Category filter — opens the sheet; mirrors the calendar button's height. Shown only
              when the catalog actually has categories to filter by. */}
          {presentCategories.length > 0 && (
            <ClearableFilterChip
              active={activeCategories.length > 0}
              onClick={() => setCategoryPickerOpen(true)}
              onClear={() => setActiveCategories([])}
              clearLabel="Quitar el filtro de categoría"
              aria-label={
                activeCategories.length > 0
                  ? `Filtrar por categoría — ${activeCategories.map(categoryLabel).join(', ')}`
                  : 'Filtrar por categoría'
              }
              startIcon={<TuneRounded sx={{ fontSize: 20 }} />}
            >
              {categoryChipLabel(activeCategories)}
            </ClearableFilterChip>
          )}

          {/* Calendar button — opens the sheet. It shows an explicit day/range pick, and NAMES the
              default window (DEFAULT_RANGE_LABEL) when there is none, so "no filter" is a stated
              scope rather than a bare icon. Its ✕ returns the catalog to that default (US-AG35).
              Note what the ✕ deliberately does NOT touch: `hideSoldOut` is a persisted Settings
              preference, not a strip filter — resetting it here would surprise the agent later. */}
          <ClearableFilterChip
            active={calendarSelection !== null}
            onClick={() => setDatePickerOpen(true)}
            onClear={() => setSelection(null)}
            clearLabel="Quitar el filtro de fecha"
            aria-label="Abrir calendario"
            startIcon={<CalendarMonthRounded sx={{ fontSize: 20 }} />}
          >
            {calendarSelection
              ? calendarSelection.to
                ? rangePillLabel(calendarSelection.from, calendarSelection.to)
                : dayPillLabel(calendarSelection.from)
              : DEFAULT_RANGE_LABEL}
          </ClearableFilterChip>
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
              {visibleServices.map((item) => {
                const isTypeCard = item.item_type === 'unit_type'
                return (
                // Structure-first: the theme gives the card its hairline border + 16px radius
                // and no resting shadow — readable in any light (replaces the old soft-shadow).
                <Card key={item.id} sx={{ position: 'relative' }}>
                  {/* US-AG45 (D2) — the ⚡ Venta Express entry point. An absolutely-positioned
                      SIBLING of the CardActionArea, never a child (a button inside a button is
                      the classic nesting/a11y fault); renders only where Express can work
                      (slot-based, non-zoned, sellable today — server-computed D4 flag). */}
                  {item.item_type === 'tour' && item.express_eligible && (
                    <IconButton
                      aria-label={`Venta Express — ${item.name}`}
                      color="secondary"
                      onClick={() => setExpressServiceId(item.id)}
                      sx={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        zIndex: 1,
                        border: '1px solid',
                        borderColor: 'grey.300',
                        bgcolor: 'background.paper',
                      }}
                    >
                      <BoltRounded fontSize="small" />
                    </IconButton>
                  )}
                  <CardActionArea
                    onClick={() =>
                      item.item_type === 'unit_type'
                        ? setOpenLodging({
                            serviceId: item.service_id,
                            typeId: item.id,
                            name: item.name,
                            propertyName: item.property_name || undefined,
                            maxCapacity: item.max_capacity,
                          })
                        : setOpenService({
                            id: item.id,
                            nextSlotDate: item.next_slot_date,
                          })
                    }
                    sx={{
                      height: '100%',
                      transition: 'transform 240ms ease',
                      '&:active': { transform: 'scale(0.99)' },
                    }}
                  >
                    <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
                      {/* Availability leads — the agent reads this before the name.
                          With "ocultar agotados" on, the list is already availability-only, so a
                          "Disponible" chip on every card is redundant — show it only when sold-out
                          cards can appear (filter off), where it earns its place distinguishing
                          Disponible from Agotado. The category tag (US-A37) follows, so it still
                          leads the row when availability is hidden. */}
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        {!hideSoldOut && (
                          <AvailabilityChip available={item.has_availability} />
                        )}
                        {item.category && (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={categoryLabel(item.category)}
                          />
                        )}
                      </Stack>

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
                        {item.name}
                      </Typography>

                      {/* A type card grounds itself in its property; a tour keeps its blurb. */}
                      {item.item_type === 'unit_type' && item.property_name ? (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          {item.property_name}
                        </Typography>
                      ) : (
                        item.description && (
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
                            {item.description}
                          </Typography>
                        )
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
                            {/* v2 — a type card's rate is EXACT (its own base rate), not "Desde". */}
                            {isTypeCard ? 'Por noche' : 'Desde'}
                          </Typography>
                          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'baseline' }}>
                            <MoneyText
                              cents={
                                item.item_type === 'unit_type'
                                  ? item.nightly_rate
                                  : item.base_price
                              }
                              variant="h3"
                              srLabel={
                                isTypeCard ? `${item.name}, por noche` : `${item.name}, desde`
                              }
                            />
                            {isTypeCard && (
                              <Typography variant="body2" color="text.secondary">
                                / noche
                              </Typography>
                            )}
                          </Stack>
                        </Box>
                        {item.item_type === 'tour' && item.next_slot_date && (
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
                              {nextDateLabel(item.next_slot_date)}
                            </Typography>
                            {/* US-AG56 — the departure hour, on its own line so the pair never
                                competes with MoneyText for width at 390px (the #104 lesson).
                                Printed as the stored naive `HH:MM`: no `Date` is constructed, so
                                no device time zone can shift it, and it reads identically to the
                                slot chip the agent taps next in the sheet. */}
                            {item.next_slot_time && (
                              <Typography
                                className="numeric"
                                sx={{ fontSize: 15, fontWeight: 700, lineHeight: 1 }}
                              >
                                {item.next_slot_time}
                              </Typography>
                            )}
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
        onClear={() => setSelection(null)}
      />

      {/* US-A37 — the category filter Bottom Sheet (multi-select, applies live). */}
      <PosCategorySheet
        open={categoryPickerOpen}
        onClose={() => setCategoryPickerOpen(false)}
        categories={presentCategories}
        active={activeCategories}
        onToggle={toggleCategory}
        onClear={() => setActiveCategories([])}
      />

      {/* US-AG31 — Bottom Sheet for fast sale config; closes + snackbars on add. */}
      <ServiceSheet
        serviceId={openService?.id ?? null}
        nextSlotDate={openService?.nextSlotDate ?? null}
        onClose={() => setOpenService(null)}
        onAdded={() => {
          setOpenService(null)
          setAdded(true)
        }}
      />

      {/* US-AG45 — the same sheet in ⚡ express mode. It stays open across sales (the reset
          loop lives inside the panel); closing it is the agent's own gesture. */}
      <ServiceSheet
        serviceId={expressServiceId}
        express
        onClose={() => setExpressServiceId(null)}
        onAdded={() => {}}
      />

      {/* US-AG36 (v2) — type-centric stay sheet (calendar + guests + rooms). */}
      <LodgingStaySheet
        target={openLodging}
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
