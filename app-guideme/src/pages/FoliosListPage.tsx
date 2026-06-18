import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
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
import { useFolios, usePendingCancellationCount } from '../features/folios/hooks'
import { CancellationRequestsTab } from '../features/folios/components/CancellationRequestsTab'
import { BookingWhatsAppButton, isUrgentBooking, venceLabel } from '../features/bookings'
import type { FolioStatus } from '../features/folios/types'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

const STATUS_COLOR: Record<FolioStatus, 'success' | 'info' | 'error'> = {
  paid: 'success',
  booking: 'info',
  cancelled: 'error',
}

const STATUS_LABEL: Record<FolioStatus, string> = {
  paid: 'Pagado',
  booking: 'Reserva',
  cancelled: 'Cancelado',
}

const formatDate = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

type Filter = 'all' | FolioStatus

// The browse-and-cancel list (US-A21), unchanged — now one tab of the Folios screen.
function FoliosTab() {
  const [filter, setFilter] = useState<Filter>('all')
  const { data: folios, isLoading, isError } = useFolios(
    filter === 'all' ? {} : { status: filter },
  )

  return (
    <Box>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
          sx={{ mb: 3 }}
        >
          <ToggleButton value="all">Todos</ToggleButton>
          <ToggleButton value="paid">Pagado</ToggleButton>
          <ToggleButton value="booking">Reservas</ToggleButton>
          <ToggleButton value="cancelled">Cancelado</ToggleButton>
        </ToggleButtonGroup>

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
                          <Chip
                            size="small"
                            color={STATUS_COLOR[f.status]}
                            label={STATUS_LABEL[f.status]}
                          />
                          {isBooking && <BookingWhatsAppButton folio={f} />}
                        </Stack>
                      </Stack>
                      <Divider sx={{ my: 1.5 }} />
                      <Stack direction="row" spacing={3}>
                        <Box>
                          <Typography variant="caption" color="text.secondary">Total</Typography>
                          <Typography variant="body2">{formatMoney(f.total)}</Typography>
                        </Box>
                        <Box>
                          <Typography variant="caption" color="text.secondary">
                            {isBooking ? 'Anticipo' : 'Pagado'}
                          </Typography>
                          <Typography variant="body2">{formatMoney(f.amount_paid)}</Typography>
                        </Box>
                        {isBooking && (
                          <Box>
                            <Typography variant="caption" color="text.secondary">
                              Saldo pendiente
                            </Typography>
                            <Typography variant="body2" color="primary">
                              {formatMoney(f.pending_balance ?? f.total - f.amount_paid)}
                            </Typography>
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

export default function FoliosListPage() {
  const [tab, setTab] = useState(0)
  // US-T04 (D7) — pending tourists' cancellation requests surface as a badge so the
  // queue can't be missed without polluting the main list.
  const { data: pendingCount = 0 } = usePendingCancellationCount(true)

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
          Ventas
        </Typography>

        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }}>
          <Tab label="Folios" />
          <Tab
            label={
              <Badge badgeContent={pendingCount} color="warning" sx={{ '& .MuiBadge-badge': { right: -12 } }}>
                Solicitudes
              </Badge>
            }
          />
        </Tabs>

        {tab === 0 ? <FoliosTab /> : <CancellationRequestsTab />}
      </Box>
    </Fade>
  )
}
