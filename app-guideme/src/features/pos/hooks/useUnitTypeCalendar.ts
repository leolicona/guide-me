import { useQuery } from '@tanstack/react-query'
import { getUnitTypeCalendar } from '../../../services/posLodgingService'

// US-AG37 (v2) — a unit type's remaining-count calendar (rooms free + rate per day).
export function useUnitTypeCalendar(
  typeId: string,
  range: { from: string; to: string },
  enabled = true,
) {
  return useQuery({
    queryKey: ['unit-type-calendar', typeId, range.from, range.to],
    queryFn: () => getUnitTypeCalendar(typeId, range),
    enabled: enabled && !!typeId && !!range.from && !!range.to,
  })
}
