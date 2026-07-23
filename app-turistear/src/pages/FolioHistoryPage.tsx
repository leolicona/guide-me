import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Divider,
  Chip,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import { useMyFolios } from '../features/pos/hooks'
import { useOrgDateFormatter } from '../features/organization'
import {
  BookingWhatsAppButton,
  DeliveryBadge,
  isUrgentBooking,
  venceLabel,
} from '../features/bookings'
import { FolioStatusChip } from '../features/folios'
import type { FolioStatus } from '../features/pos/types'
import { MoneyText } from '../components'
import { ROUTES } from '../config/routes'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

type Filter = 'all' | FolioStatus

// US-AG20 — the agent's own read-only sales history. Tapping a row opens the detail
// (US-AG21). No cancel/edit affordance — cancellation is admin-only.
export default function FolioHistoryPage() {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
  const [filter, setFilter] = useState<Filter>('all')
  const { data: folios, isLoading, isError } = useMyFolios(
    filter === 'all' ? {} : { status: filter },
  )

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Ventas
        </Typography>

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
        {isError && (
          <Alert severity="error">
            No se pudo cargar tu historial. Inténtalo de nuevo.
          </Alert>
        )}

        {folios && folios.length === 0 && (
          <Typography color="text.secondary">
            Aún no tienes ventas registradas.
          </Typography>
        )}

        {folios && folios.length > 0 && (
          <Stack spacing={2}>
            {folios.map((f) => {
              // US-AG07.3/07.5 — apartado affordances integrated into THIS existing card: an
              // urgency accent + countdown + the WhatsApp recovery button. No separate dashboard.
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
                    to={ROUTES.HISTORY_DETAIL.replace(':id', f.id)}
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
                            {formatDate(f.created_at)}
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
                          {/* whatsapp-qr-delivery — the delivery badge (send lives on detail). */}
                          <DeliveryBadge folio={f} />
                          {isBooking && <BookingWhatsAppButton folio={f} />}
                        </Stack>
                      </Stack>
                      <Divider sx={{ my: 1.5 }} />
                      <Stack direction="row" spacing={3}>
                        <Box>
                          <Typography variant="caption" color="text.secondary">
                            Total
                          </Typography>
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
                            {/* Owed by the customer — neutral ink, not teal. */}
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
    </Fade>
  )
}
