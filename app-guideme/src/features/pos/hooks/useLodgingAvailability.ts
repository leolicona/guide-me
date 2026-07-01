import { useQuery } from '@tanstack/react-query'
import { getLodgingAvailability } from '../../../services/posLodgingService'

// US-AG36 — range-first availability. The query is enabled only once the range is valid
// (check_out strictly after check_in) so an incomplete picker never hits the API.
export function useLodgingAvailability(
  serviceId: string,
  range: { check_in: string; check_out: string; guests: number },
) {
  const valid =
    !!serviceId &&
    !!range.check_in &&
    !!range.check_out &&
    range.check_out > range.check_in &&
    range.guests >= 1

  return useQuery({
    queryKey: ['lodging-availability', serviceId, range.check_in, range.check_out, range.guests],
    queryFn: () => getLodgingAvailability(serviceId, range),
    enabled: valid,
  })
}
