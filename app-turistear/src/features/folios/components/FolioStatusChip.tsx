import { StatusChip } from '../../../components'
import type { FolioStatus } from '../types'

// One canonical presentation for a folio's lifecycle status, used everywhere a folio is listed
// or shown (list, detail, history). Renders via the shared StatusChip (functional color + icon,
// never teal).
//
// "Apartado", never "Reserva" (BUG-026 / folio-state-machine D8). This chip used to say "Reserva"
// while `folioCardState` said "Apartado" for the same `status`, on screens a seller sees in the
// same session. The word is retired from the product, not disambiguated: it described what an
// apartado and a paid folio BOTH do — hold inventory — so it distinguished nothing.
const FOLIO_LABEL: Record<FolioStatus, string> = {
  paid: 'Pagado',
  booking: 'Apartado',
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
