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
import type { FolioStatus } from '../features/pos/types'
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

// US-AG20 — the agent's own read-only sales history. Tapping a row opens the detail
// (US-AG21). No cancel/edit affordance — cancellation is admin-only.
export default function FolioHistoryPage() {
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
            {folios.map((f) => (
              <Card key={f.id} variant="outlined">
                <CardActionArea
                  component={RouterLink}
                  to={ROUTES.HISTORY_DETAIL.replace(':id', f.id)}
                >
                  <CardContent>
                    <Stack
                      direction="row"
                      sx={{ justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle1" noWrap>
                          {f.customer_name ?? 'Sin nombre'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatDate(f.created_at)}
                        </Typography>
                      </Box>
                      <Chip
                        size="small"
                        color={STATUS_COLOR[f.status]}
                        label={STATUS_LABEL[f.status]}
                      />
                    </Stack>
                    <Divider sx={{ my: 1.5 }} />
                    <Stack direction="row" spacing={3}>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Total
                        </Typography>
                        <Typography variant="body2">{formatMoney(f.total)}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Pagado
                        </Typography>
                        <Typography variant="body2">
                          {formatMoney(f.amount_paid)}
                        </Typography>
                      </Box>
                    </Stack>
                  </CardContent>
                </CardActionArea>
              </Card>
            ))}
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
