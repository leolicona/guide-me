import { Box, Card, CardActionArea, Chip, Fade, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { Link as RouterLink } from 'react-router-dom'
import type { SvgIconComponent } from '@mui/icons-material'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import AccountBalanceWalletRounded from '@mui/icons-material/AccountBalanceWalletRounded'
import SendRounded from '@mui/icons-material/SendRounded'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import HourglassBottomRounded from '@mui/icons-material/HourglassBottomRounded'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import { useFolioCounts } from '../features/folios/hooks'
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
  const { data: pendingDropCount = 0 } = usePendingDropCount(true)
  // US-A84 (D7/D20) — ONE aggregate for all four folio counts, shared with the list's pending-work
  // bar so the two surfaces cannot show different numbers. Before this, each of these was a full
  // filtered list fetched to call `.length` — three unbounded reads of `folios` to render `Hoy`,
  // one of which pulled every paid folio WITH its lines and portal link.
  const { data: counts } = useFolioCounts(true)
  const pendingCancellationCount = counts?.folio_requests ?? 0
  const pendingRefundCount = counts?.refunds ?? 0
  const overdueBookingCount = counts?.overdue ?? 0
  const pendingDeliveryCount = counts?.undelivered ?? 0

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
            // US-A84 — this linked to a BARE /folios: tapping "3 Cancelaciones" landed the admin on
            // the unfiltered list of every folio, to re-filter by hand. Now it lands on its facet.
            to={`${ROUTES.FOLIOS}?estado=solicitud`}
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
            to={`${ROUTES.FOLIOS}?estado=reembolso`}
          />
          {/* US-A79 — holds past their deadline, still sitting on seats. */}
          <QueueCard
            icon={HourglassBottomRounded}
            count={overdueBookingCount}
            title="Apartados vencidos"
            pendingHint="Sin liquidar, en Ventas"
            emptyHint="Sin apartados vencidos"
            to={`${ROUTES.FOLIOS}?estado=vencido`}
          />
          {/* US-A80 — the pending-delivery queue: a customer who walked away without scanning
              still gets their ticket (the one-tap WhatsApp in Ventas clears it). */}
          <QueueCard
            icon={SendRounded}
            count={pendingDeliveryCount}
            title="Boletos"
            pendingHint="Boletos sin entregar en Ventas"
            emptyHint="Todos los boletos entregados"
            // US-A84 — the second bare link. Same fix.
            to={`${ROUTES.FOLIOS}?estado=sin_enviar`}
          />
        </Stack>
      </Box>
    </Fade>
  )
}
