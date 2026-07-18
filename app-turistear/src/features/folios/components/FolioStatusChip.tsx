import { StatusChip } from '../../../components'
import type { FolioStatus } from '../types'

// One canonical presentation for a folio's lifecycle status, used everywhere a folio is listed
// or shown (list, detail, history). Renders via the shared StatusChip (functional color + icon,
// never teal). Labels are the app's established wording — "Reserva" for a booking/apartado.
const FOLIO_LABEL: Record<FolioStatus, string> = {
  paid: 'Pagado',
  booking: 'Reserva',
  cancelled: 'Cancelado',
}

export function FolioStatusChip({
  status,
  size = 'small',
}: {
  status: FolioStatus
  size?: 'small' | 'medium'
}) {
  // status maps 1:1 to a StatusChip preset (paid→success, booking→warning, cancelled→error);
  // we keep the app's label wording via the override.
  return <StatusChip status={status} label={FOLIO_LABEL[status]} size={size} />
}
