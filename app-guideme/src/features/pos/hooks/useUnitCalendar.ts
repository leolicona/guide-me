import { useQuery } from '@tanstack/react-query'
import { getUnitCalendar } from '../../../services/posLodgingService'

// US-AG37 — unit-first month availability calendar.
export function useUnitCalendar(
  unitId: string,
  range: { from: string; to: string },
  enabled = true,
) {
  return useQuery({
    queryKey: ['unit-calendar', unitId, range.from, range.to],
    queryFn: () => getUnitCalendar(unitId, range),
    enabled: enabled && !!unitId && !!range.from && !!range.to,
  })
}
