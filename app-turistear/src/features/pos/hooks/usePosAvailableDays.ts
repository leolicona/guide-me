import { useQuery } from '@tanstack/react-query'
import { getPosAvailabilityDays } from '../../../services/posService'

export const POS_AVAILABLE_DAYS_QUERY_KEY = ['pos', 'available-days'] as const

// US-AG35 — the set of sellable dates within `month` (YYYY-MM), feeding the calendar
// Bottom Sheet's day marks. `today` pins the org-local anchor. `categories` (US-A37)
// scopes the dots to the agent's selected category filter (empty = all). Keyed on the
// month + category set so paging months or changing the filter refetches; `enabled`
// lets the caller defer until the sheet is open.
export function usePosAvailableDays(
  month: string,
  today?: string,
  enabled = true,
  categories: readonly string[] = [],
) {
  // Order-independent, stable key for the category set.
  const categoryKey = [...categories].sort().join(',')
  return useQuery({
    queryKey: [...POS_AVAILABLE_DAYS_QUERY_KEY, month, today ?? null, categoryKey],
    queryFn: () => getPosAvailabilityDays(month, today, categories),
    enabled,
  })
}
