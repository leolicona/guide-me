import { useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import {
  Box,
  Typography,
  Badge,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Divider,
  Chip,
  Tab,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import {
  useFolios,
  usePendingCancellationCount,
  usePendingVerificationCount,
  usePendingRefundCount,
  useOverdueBookingCount,
  FolioStatusChip,
} from '../features/folios'
import { useOrgDateFormatter } from '../features/organization'
import type { FolioStatus } from '../features/folios'
import { CancellationRequestsTab } from '../features/folios/components/CancellationRequestsTab'
import { PaymentVerificationTab } from '../features/folios/components/PaymentVerificationTab'
import { PendingRefundsTab } from '../features/folios/components/PendingRefundsTab'
import { OverdueBookingsTab } from '../features/folios/components/OverdueBookingsTab'
import {
  BookingWhatsAppButton,
  DeliveryBadge,
  isUrgentBooking,
  venceLabel,
} from '../features/bookings'
import { MoneyText } from '../components'
import { FilterStrip } from '../features/filters'
import { ROUTES } from '../config/routes'
import { deliveryState } from '../features/pos/delivery'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// US-A80 — 'undelivered' is a client-side view over the loaded list: folios still
// `● Pendiente de enviar` on the delivery axis (paid, portal link issued, never sent/seen).
type Filter = 'all' | FolioStatus | 'undelivered'

// The browse-and-cancel list (US-A21), unchanged — now one tab of the Folios screen.
function FoliosTab() {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
  const [filter, setFilter] = useState<Filter>('all')
  const { data: rows, isLoading, isError } = useFolios(
    filter === 'all' || filter === 'undelivered' ? {} : { status: filter },
  )
  // US-A80 — the pending-delivery queue: what the existing one-tap WhatsApp is for.
  const folios =
    filter === 'undelivered'
      ? rows?.filter((f) => deliveryState(f) === 'pending')
      : rows

  return (
    <Box>
        {/* BUG-023, second half — the same root cause one row down. This group measures 397px, so
            below ~412px it makes the DOCUMENT wider than the viewport. Clicking a button whose
            right edge sits outside then makes the browser scroll it into view, dragging the whole
            page sideways: measured at 320px, the "Ventas" heading went from x=16 to x=-61.
            Containing the scroll here keeps it inside the row, where it belongs. The strip is
            edge-bleeding on mobile so a pill can sit flush, matching the filter rows in /pos and
            Reportes (`filterStripSx`). */}
        <FilterStrip sx={{ mb: 3 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
        >
          <ToggleButton value="all">Todos</ToggleButton>
          <ToggleButton value="paid">Pagado</ToggleButton>
          <ToggleButton value="booking">Reservas</ToggleButton>
          <ToggleButton value="cancelled">Cancelado</ToggleButton>
          <ToggleButton value="undelivered">Sin entregar</ToggleButton>
        </ToggleButtonGroup>
        </FilterStrip>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && <Alert severity="error">No se pudieron cargar los folios. Inténtalo de nuevo.</Alert>}

        {folios && folios.length === 0 && (
          <Typography color="text.secondary">No hay folios para mostrar.</Typography>
        )}

        {folios && folios.length > 0 && (
          <Stack spacing={2}>
            {folios.map((f) => {
              // US-AG07.3/D5 — apartado affordances integrated into the admin card too:
              // urgency accent, countdown, pending balance + the WhatsApp recovery button.
              const isBooking = f.status === 'booking'
              const urgent = isBooking && isUrgentBooking(f.booking_expires_at)
              return (
                <Card
                  key={f.id}
                  variant="outlined"
                  sx={
                    isBooking
                      ? {
                          borderLeftWidth: 4,
                          borderLeftColor: urgent ? 'warning.main' : 'divider',
                        }
                      : undefined
                  }
                >
                  <CardActionArea
                    component={RouterLink}
                    to={ROUTES.FOLIO_DETAIL.replace(':id', f.id)}
                  >
                    <CardContent>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="subtitle1" noWrap>
                            {f.customer_name ?? 'Sin nombre'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {formatDate(f.created_at)} · {f.agent.name}
                          </Typography>
                          {isBooking && f.booking_expires_at != null && (
                            <Chip
                              size="small"
                              variant="outlined"
                              color={urgent ? 'warning' : 'default'}
                              label={venceLabel(f.booking_expires_at)}
                              sx={{ mt: 0.5, display: 'flex', width: 'fit-content' }}
                            />
                          )}
                        </Box>
                        {/* Status chip + WhatsApp sit side by side in one cluster — never overlap. */}
                        <Stack
                          direction="row"
                          spacing={0.5}
                          sx={{ alignItems: 'center', flexShrink: 0 }}
                        >
                          <FolioStatusChip status={f.status} />
                          {/* whatsapp-qr-delivery — admin oversight of undelivered tickets. */}
                          <DeliveryBadge folio={f} />
                          {isBooking && <BookingWhatsAppButton folio={f} />}
                        </Stack>
                      </Stack>
                      <Divider sx={{ my: 1.5 }} />
                      <Stack direction="row" spacing={3}>
                        <Box>
                          <Typography variant="caption" color="text.secondary">Total</Typography>
                          <MoneyText cents={f.total} variant="body2" sx={{ display: 'block' }} />
                        </Box>
                        <Box>
                          <Typography variant="caption" color="text.secondary">
                            {isBooking ? 'Anticipo' : 'Pagado'}
                          </Typography>
                          <MoneyText cents={f.amount_paid} variant="body2" sx={{ display: 'block' }} />
                        </Box>
                        {isBooking && (
                          <Box>
                            <Typography variant="caption" color="text.secondary">
                              Saldo pendiente
                            </Typography>
                            {/* Owed by the customer — neutral ink, not teal (teal = action). */}
                            <MoneyText
                              cents={f.pending_balance ?? f.total - f.amount_paid}
                              variant="body2"
                              sx={{ display: 'block' }}
                            />
                          </Box>
                        )}
                      </Stack>
                    </CardContent>
                  </CardActionArea>
                </Card>
              )
            })}
          </Stack>
        )}
    </Box>
  )
}

// US-A78/A79 — Hoy's queue cards deep-link here. Without carrying the target tab the card would
// drop the admin on tab 0, which is not the list they tapped.
//
// The `?tab=` param IS the state — it is not merely read once to seed it. Seeding `useState` from
// the URL was the first cut and it drifted: React Router keeps this component MOUNTED when only
// the query string changes (the route path `/folios` is unchanged), so the initializer never ran
// again. Arriving from the Hoy card and then tapping "Ventas" in the nav left the URL saying
// `/folios` while the page still showed Reembolsos — and a reload of that same URL showed Folios.
// One address, three different screens, decided by history. Deriving it removes the copy that
// could disagree, and the URL becomes shareable and reload-stable for free.
const TAB_KEYS = ['folios', 'verify', 'requests', 'refunds', 'overdue'] as const

export default function FoliosListPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = Math.max(0, TAB_KEYS.indexOf(searchParams.get('tab') as never))
  // `replace` so switching tabs does not stack history entries the back button has to walk out of.
  const setTab = (next: number) =>
    setSearchParams(next === 0 ? {} : { tab: TAB_KEYS[next] }, { replace: true })
  // US-T04 (D7) — pending tourists' cancellation requests surface as a badge so the
  // queue can't be missed without polluting the main list.
  const { data: pendingCount = 0 } = usePendingCancellationCount(true)
  // US-A67 — the "Por verificar" queue: electronic payments awaiting an admin.
  const { data: verifyCount = 0 } = usePendingVerificationCount(true)
  // US-A78/A79 — the two work queues.
  const { data: refundCount = 0 } = usePendingRefundCount(true)
  const { data: overdueCount = 0 } = useOverdueBookingCount(true)

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
          Ventas
        </Typography>

        {/* BUG-023 — five tabs measure 569px against a 358px scroller on a phone, and the default
            `standard` variant clips the overflow with `overflow-x: hidden` and no scroll buttons.
            Reembolsos and Vencidos were therefore UNREACHABLE below ~600px: no arrows, no touch
            scroll, and their count badges invisible too — two money queues (US-A78/A79) that
            shipped and never worked on the device the booth actually uses.
            `allowScrollButtonsMobile` is the load-bearing half: MUI hides the arrows on mobile by
            default, which is precisely where they are the only way through. */}
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{ mb: 3 }}
        >
          <Tab label="Folios" />
          <Tab
            label={
              <Badge badgeContent={verifyCount} color="warning" sx={{ '& .MuiBadge-badge': { right: -12 } }}>
                Por verificar
              </Badge>
            }
          />
          <Tab
            label={
              <Badge badgeContent={pendingCount} color="warning" sx={{ '& .MuiBadge-badge': { right: -12 } }}>
                Solicitudes
              </Badge>
            }
          />
          <Tab
            label={
              <Badge badgeContent={refundCount} color="warning" sx={{ '& .MuiBadge-badge': { right: -12 } }}>
                Reembolsos
              </Badge>
            }
          />
          <Tab
            label={
              <Badge badgeContent={overdueCount} color="warning" sx={{ '& .MuiBadge-badge': { right: -12 } }}>
                Vencidos
              </Badge>
            }
          />
        </Tabs>

        {tab === 0 ? (
          <FoliosTab />
        ) : tab === 1 ? (
          <PaymentVerificationTab />
        ) : tab === 2 ? (
          <CancellationRequestsTab />
        ) : tab === 3 ? (
          <PendingRefundsTab />
        ) : (
          <OverdueBookingsTab />
        )}
      </Box>
    </Fade>
  )
}
