import { useState } from 'react'
import { Box, Fade, Stack, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import { useFolioCounts } from '../features/folios/hooks'
import { PendingWorkBar } from '../features/folios'
import { useMyOrganization } from '../features/organization'
import { todayStr } from '../features/pos/dates'
import {
  DASHBOARD_POLL_MS,
  DaySalesCard,
  DayStrip,
  DepartedCard,
  OccupancyCard,
  useDashboardDay,
} from '../features/dashboard'
import { ROUTES } from '../config/routes'

// US-A14/A15/A16/A90 — the Daily Operations Dashboard as "Hoy" (Reorg Phase 2;
// docs/dashboard/occupancy-dashboard.spec.md). Top to bottom: the pending-work pills (D7 — the
// same PendingWorkBar and counts endpoint the folios list reads, so the two surfaces can never
// disagree), the day's money as the ledger stamped it (D10), the occupancy list scoped by the
// quick-day strip (D5/D12 — the strip re-scopes THIS list only), and «Ya partieron» (D9).
// Agents never route here (D4). The cash-drop queue that used to be the "Entregas" card stays on
// the Caja nav badge, which always carried the same count.
export default function DashboardPage() {
  const user = useCurrentUser()
  const navigate = useNavigate()
  const { data: org } = useMyOrganization()
  const today = todayStr(org?.timezone)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // D3 — the polling convention: both Hoy reads refresh every 60 s while this page is mounted.
  const todayQuery = useDashboardDay(undefined)
  const peekDay = selectedDay !== null && selectedDay !== today ? selectedDay : null
  const peekQuery = useDashboardDay(peekDay ?? undefined, peekDay !== null)
  const { data: counts } = useFolioCounts(true, DASHBOARD_POLL_MS)

  // D12 — the strip scopes the occupancy list alone; money, pills and «Ya partieron» are today's.
  const occupancySource = peekDay !== null ? peekQuery : todayQuery

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Hoy
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Hola, {user.name}. Así va tu día.
        </Typography>

        <PendingWorkBar
          counts={counts}
          active={[]}
          onToggle={(key) => navigate(`${ROUTES.FOLIOS}?estado=${key}`)}
        />

        {/* 24px between groups vs 12px strip-to-card inside the Salidas group — between-group
            space must exceed within-group space or the strip reads as a stray control. */}
        <Stack spacing={3}>
          <DaySalesCard sales={todayQuery.data?.sales} />
          <Box>
            <DayStrip today={today} selected={selectedDay} onSelect={setSelectedDay} />
            <OccupancyCard
              rows={occupancySource.data?.occupancy ?? []}
              loading={occupancySource.isPending}
            />
          </Box>
          <DepartedCard rows={todayQuery.data?.departed ?? []} />
        </Stack>
      </Box>
    </Fade>
  )
}
