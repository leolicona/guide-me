import { Box, Card, CardActionArea, Chip, Fade, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { Link as RouterLink } from 'react-router-dom'
import type { SvgIconComponent } from '@mui/icons-material'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import AccountBalanceWalletRounded from '@mui/icons-material/AccountBalanceWalletRounded'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import HourglassBottomRounded from '@mui/icons-material/HourglassBottomRounded'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import {
  usePendingCancellationCount,
  usePendingRefundCount,
  useOverdueBookingCount,
} from '../features/folios/hooks'
import { usePendingDropCount } from '../features/cash/hooks'
import { ROUTES } from '../config/routes'

// US-UX01 — the admin's "Hoy" landing. Interim version (Reorg Phase 1): queue cards that surface
// what needs the admin's attention today and deep-link to the destination that resolves it — four
// of them since US-A78/A79 added the two work queues (docs/oversight/pending-work-queues.spec.md).
// Reorg Phase 2 replaces this with the Daily Operations Dashboard (US-A14/A15/A16 in docs/SPEC.md;
// no spec written yet). Agents never route here.

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
  // US-A78/A79 — the two work queues that had no surface at all before this feature.
  const { data: pendingRefundCount = 0 } = usePendingRefundCount(true)
  const { data: overdueBookingCount = 0 } = useOverdueBookingCount(true)

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Hoy
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          Hola, {user.name}. Esto es lo que necesita tu atención.
        </Typography>

        {/* Four cards now: they stack on mobile and wrap in two rows from sm up. */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          useFlexGap
          sx={{ flexWrap: 'wrap' }}
        >
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
          {/* US-A78 — cash the company owes back. The count is the only place this debt is
              visible: the ledger already credited the agent at cancellation. */}
          <QueueCard
            icon={PaymentsRounded}
            count={pendingRefundCount}
            title="Reembolsos"
            pendingHint="Por entregar al cliente, en Ventas"
            emptyHint="Sin reembolsos pendientes"
            to={`${ROUTES.FOLIOS}?tab=refunds`}
          />
          {/* US-A79 — holds past their deadline, still sitting on seats. */}
          <QueueCard
            icon={HourglassBottomRounded}
            count={overdueBookingCount}
            title="Apartados vencidos"
            pendingHint="Sin liquidar, en Ventas"
            emptyHint="Sin apartados vencidos"
            to={`${ROUTES.FOLIOS}?tab=overdue`}
          />
        </Stack>
      </Box>
    </Fade>
  )
}
