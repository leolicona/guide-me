import { useState } from 'react'
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import { useMyFolios } from '../features/pos/hooks'
import { deliveryState } from '../features/pos/delivery'
import { FolioCard, useFolioSoldAt, useNowSeconds } from '../features/folios'
import type { FolioStatus } from '../features/pos/types'
import { ROUTES } from '../config/routes'
import { FilterStrip } from '../features/filters'

// US-A80 — 'undelivered' is a client-side view over the loaded list: folios still
// `● Pendiente de enviar` on the delivery axis (paid, portal link issued, never sent/seen).
type Filter = 'all' | FolioStatus | 'undelivered'

// US-AG20 — the agent's own read-only sales history. Tapping a row opens the detail
// (US-AG21). No cancel/edit affordance — cancellation is admin-only.
export default function FolioHistoryPage() {
  // US-A82 D6 — the compressed org-local sale time ("hoy 14:32"), not the full stamp.
  const soldAt = useFolioSoldAt()
  // US-A84 D19 — the clock for the card's age labels, read in an effect and refreshed every minute.
  const now = useNowSeconds()
  const [filter, setFilter] = useState<Filter>('all')
  const { data: rows, isLoading, isError } = useMyFolios(
    filter === 'all' || filter === 'undelivered' ? {} : { status: filter },
  )
  // US-A80 — the pending-delivery queue: what the existing one-tap WhatsApp is for.
  const folios =
    filter === 'undelivered'
      ? rows?.filter((f) => deliveryState(f) === 'pending')
      : rows

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Ventas
        </Typography>

        {/* BUG-023 — the filter row is wider than a phone. Contained here so the scroll stays
            inside the row instead of dragging the whole page sideways. */}
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
            {/* US-AG49 — the same card the admin sees (spec D13). The byline follows the AUDIENCE
                rather than the card: here it names the shift operator who took the sale, and a
                direct sale passes null so the line simply collapses — no placeholder dash. */}
            {folios.map((f) => (
              <FolioCard
                key={f.id}
                folio={f}
                to={ROUTES.HISTORY_DETAIL.replace(':id', f.id)}
                byline={f.operator_name}
                soldAt={soldAt(f.created_at)}
                nowSeconds={now}
                surface="seller"
              />
            ))}
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
