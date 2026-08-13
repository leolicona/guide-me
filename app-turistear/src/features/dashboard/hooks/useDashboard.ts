import { useQuery } from '@tanstack/react-query'
import { getDashboardDay } from '../../../services/dashboardService'

const DASHBOARD_KEY = ['dashboard'] as const

// D3 (occupancy-dashboard.spec.md) — the app's first polling convention: while Hoy is mounted its
// reads refresh every 60 s (and on window focus), so a second seller's sale appears without any
// interaction. Seats change at human sales speed; a sub-minute stale count is operationally live.
export const DASHBOARD_POLL_MS = 60_000

// `date` absent = the org's today, resolved server-side in the org's zone (rule 1).
export const useDashboardDay = (date?: string, enabled = true) =>
  useQuery({
    queryKey: [...DASHBOARD_KEY, 'day', date ?? 'today'] as const,
    queryFn: () => getDashboardDay(date),
    enabled,
    refetchInterval: DASHBOARD_POLL_MS,
    refetchOnWindowFocus: true,
  })
