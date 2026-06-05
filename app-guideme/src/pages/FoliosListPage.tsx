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
import { useFolios } from '../features/folios/hooks'
import type { FolioStatus } from '../features/folios/types'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

const STATUS_COLOR: Record<FolioStatus, 'success' | 'info' | 'error'> = {
  paid: 'success',
  booking: 'info',
  cancelled: 'error',
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

export default function FoliosListPage() {
  const [filter, setFilter] = useState<Filter>('all')
  const { data: folios, isLoading, isError } = useFolios(
    filter === 'all' ? {} : { status: filter },
  )

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Folios
        </Typography>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
          sx={{ mb: 3 }}
        >
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="paid">Paid</ToggleButton>
          <ToggleButton value="booking">Bookings</ToggleButton>
          <ToggleButton value="cancelled">Cancelled</ToggleButton>
        </ToggleButtonGroup>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && <Alert severity="error">Couldn't load folios. Please try again.</Alert>}

        {folios && folios.length === 0 && (
          <Typography color="text.secondary">No folios to show.</Typography>
        )}

        {folios && folios.length > 0 && (
          <Stack spacing={2}>
            {folios.map((f) => (
              <Card key={f.id} variant="outlined">
                <CardActionArea
                  component={RouterLink}
                  to={ROUTES.FOLIO_DETAIL.replace(':id', f.id)}
                >
                  <CardContent>
                    <Stack
                      direction="row"
                      sx={{ justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle1" noWrap>
                          {f.customer_name ?? 'Walk-in'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatDate(f.created_at)} · {f.agent.name}
                        </Typography>
                      </Box>
                      <Chip size="small" color={STATUS_COLOR[f.status]} label={f.status} />
                    </Stack>
                    <Divider sx={{ my: 1.5 }} />
                    <Stack direction="row" spacing={3}>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Total</Typography>
                        <Typography variant="body2">{formatMoney(f.total)}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Paid</Typography>
                        <Typography variant="body2">{formatMoney(f.amount_paid)}</Typography>
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
