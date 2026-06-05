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
import { useDrawers } from '../features/cash-drawer/hooks'
import type { DrawerStatus } from '../features/cash-drawer/types'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

const STATUS_COLOR: Record<DrawerStatus, 'default' | 'info' | 'success' | 'error'> = {
  open: 'default',
  submitted: 'info',
  approved: 'success',
  rejected: 'error',
}

type Filter = 'submitted' | 'approved' | 'rejected' | 'all'

export default function ClosuresListPage() {
  const [filter, setFilter] = useState<Filter>('submitted')
  const { data: drawers, isLoading, isError } = useDrawers(
    filter === 'all' ? {} : { status: filter },
  )

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Cash closures
        </Typography>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
          sx={{ mb: 3 }}
        >
          <ToggleButton value="submitted">To review</ToggleButton>
          <ToggleButton value="approved">Approved</ToggleButton>
          <ToggleButton value="rejected">Rejected</ToggleButton>
          <ToggleButton value="all">All</ToggleButton>
        </ToggleButtonGroup>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && <Alert severity="error">Couldn't load closures. Please try again.</Alert>}

        {drawers && drawers.length === 0 && (
          <Typography color="text.secondary">No closures to show.</Typography>
        )}

        {drawers && drawers.length > 0 && (
          <Stack spacing={2}>
            {drawers.map((d) => (
              <Card key={d.id} variant="outlined">
                <CardActionArea
                  component={RouterLink}
                  to={ROUTES.CLOSURE_DETAIL.replace(':id', d.id)}
                >
                  <CardContent>
                    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <Box>
                        <Typography variant="subtitle1">{d.agent.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {d.business_date} · {d.folio_count} folios
                        </Typography>
                      </Box>
                      <Chip size="small" color={STATUS_COLOR[d.status]} label={d.status} />
                    </Stack>
                    <Divider sx={{ my: 1.5 }} />
                    <Stack direction="row" spacing={3}>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Collected</Typography>
                        <Typography variant="body2">{formatMoney(d.total_collected)}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Expenses</Typography>
                        <Typography variant="body2">{formatMoney(d.expense_total)}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Net</Typography>
                        <Typography
                          variant="body2"
                          color={d.net_balance < 0 ? 'error.main' : 'text.primary'}
                        >
                          {formatMoney(d.net_balance)}
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
