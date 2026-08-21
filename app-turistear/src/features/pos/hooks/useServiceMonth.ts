import { useQuery } from '@tanstack/react-query'
import {
  getServiceAvailabilityDays,
  type ServiceMonthAvailability,
} from '../../../services/posService'

export const SERVICE_MONTH_QUERY_KEY = ['pos', 'service-month'] as const

// US-AG57 — one service's month, classified into available / sold-out days for the sale sheet's
// calendar. Keyed on (service, month, party) so paging months or changing the group refetches;
// `enabled` defers until the sheet is actually open, because a catalog page must never fetch a
// calendar for a card nobody tapped.
//
// `placeholderData` keeps the PREVIOUS month's answer on screen while the next one loads. The
// party stepper long-presses (`useRepeatPress`), so a naive refetch would blank the grid on every
// tick; holding the stale paint until the new one lands is the difference between a calendar that
// flickers under the thumb and one that does not.
export function useServiceMonth(
  serviceId: string | undefined,
  month: string,
  party: number,
  today?: string,
  enabled = true,
) {
  return useQuery<ServiceMonthAvailability>({
    queryKey: [...SERVICE_MONTH_QUERY_KEY, serviceId ?? null, month, party, today ?? null],
    queryFn: () => getServiceAvailabilityDays(serviceId as string, month, party, today),
    enabled: enabled && !!serviceId,
    placeholderData: (prev) => prev,
  })
}
