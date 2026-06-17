import { useQuery } from '@tanstack/react-query'
import { getPosAvailabilityDays } from '../../../services/posService'

export const POS_AVAILABLE_DAYS_QUERY_KEY = ['pos', 'available-days'] as const

// US-AG35 — the set of sellable dates within `month` (YYYY-MM), feeding the calendar
// Bottom Sheet's day marks. `today` pins the org-local anchor. Keyed on the month so
// paging months refetches; `enabled` lets the caller defer until the sheet is open.
export function usePosAvailableDays(
  month: string,
  today?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: [...POS_AVAILABLE_DAYS_QUERY_KEY, month, today ?? null],
    queryFn: () => getPosAvailabilityDays(month, today),
    enabled,
  })
}
