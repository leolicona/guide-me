import { useQuery } from '@tanstack/react-query'
import { getLodgingAvailability } from '../../../services/posLodgingService'

// US-AG36 (v2) — range-first availability with a room quantity (D12). The query is enabled only
// once the range is valid (check_out strictly after check_in) so an incomplete picker never hits
// the API.
export function useLodgingAvailability(
  serviceId: string,
  range: { check_in: string; check_out: string; guests: number; quantity: number },
) {
  const valid =
    !!serviceId &&
    !!range.check_in &&
    !!range.check_out &&
    range.check_out > range.check_in &&
    range.guests >= 1 &&
    range.quantity >= 1

  return useQuery({
    queryKey: [
      'lodging-availability',
      serviceId,
      range.check_in,
      range.check_out,
      range.guests,
      range.quantity,
    ],
    queryFn: () => getLodgingAvailability(serviceId, range),
    enabled: valid,
  })
}
