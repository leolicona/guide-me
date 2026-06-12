import { Box, Card, CardActionArea, Chip, Fade, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { Link as RouterLink } from 'react-router-dom'
import type { SvgIconComponent } from '@mui/icons-material'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import AccountBalanceWalletRounded from '@mui/icons-material/AccountBalanceWalletRounded'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import { usePendingCancellationCount } from '../features/folios/hooks'
import { usePendingDropCount } from '../features/cash/hooks'
import { ROUTES } from '../config/routes'

// US-UX01 — the admin's "Hoy" landing. Interim version (Reorg Phase 1): two queue cards that
// surface what needs the admin's attention today and deep-link to the destination that
// resolves it. Reorg Phase 2 replaces this with the Daily Operations Dashboard
// (docs/dashboard/occupancy-dashboard.spec.md). Agents never route here.

interface QueueCardProps {
  icon: SvgIconComponent
  count: number
  title: string
  emptyHint: string
  pendingHint: string
  to: string
}

function QueueCard({ icon: Icon, count, title, emptyHint, pendingHint, to }: QueueCardProps) {
  const hasPending = count > 0
  return (
    <Card variant="outlined" sx={{ flex: 1, minWidth: 0 }}>
      <CardActionArea component={RouterLink} to={to} sx={{ p: 2.5, height: '100%' }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <Box
            sx={{
              width: 48,
              height: 48,
              borderRadius: 2.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: hasPending ? 'secondary.main' : 'text.secondary',
              bgcolor: (t) =>
                hasPending ? alpha(t.palette.secondary.main, 0.12) : 'action.hover',
            }}
          >
            <Icon />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                {title}
              </Typography>
              {hasPending && <Chip size="small" color="warning" label={count} />}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {hasPending ? pendingHint : emptyHint}
            </Typography>
          </Box>
        </Stack>
      </CardActionArea>
    </Card>
  )
}

export default function DashboardPage() {
  const user = useCurrentUser()
  // Admin-only route, so both feeds are always enabled here.
  const { data: pendingCancellationCount = 0 } = usePendingCancellationCount(true)
  const { data: pendingDropCount = 0 } = usePendingDropCount(true)

  return (
    <Fade in timeout={400}>
      <Box>
        <Typography variant="h4" component="h1" gutterBottom>
          Hoy
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          Hola, {user.name}. Esto es lo que necesita tu atención.
        </Typography>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <QueueCard
            icon={EventBusyRounded}
            count={pendingCancellationCount}
            title="Cancelaciones"
            pendingHint="Solicitudes por revisar en Ventas"
            emptyHint="Sin solicitudes pendientes"
            to={ROUTES.FOLIOS}
          />
          <QueueCard
            icon={AccountBalanceWalletRounded}
            count={pendingDropCount}
            title="Entregas"
            pendingHint="Entregas de efectivo por confirmar en Caja"
            emptyHint="Sin entregas por confirmar"
            to={ROUTES.CASH}
          />
        </Stack>
      </Box>
    </Fade>
  )
}
