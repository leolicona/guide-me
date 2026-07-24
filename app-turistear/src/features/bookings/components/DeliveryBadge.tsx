import ScheduleSendRounded from '@mui/icons-material/ScheduleSend'
import DoneRounded from '@mui/icons-material/Done'
import VisibilityRounded from '@mui/icons-material/Visibility'
import { StatusChip } from '../../../components'
import { deliveryState } from '../../pos/delivery'

// The Pendiente → Enviado → Visto badge (whatsapp-qr-delivery D4/D7). A separate axis from payment
// status. Amber = the agent still owes a send; neutral = sent; green = the tourist opened the portal
// ("Visto", never "Validado" — that word belongs to QR scanning). Renders nothing off-axis.
export function DeliveryBadge({
  folio,
  size = 'small',
}: {
  folio: {
    portal_link?: string | null
    deliverable?: boolean
    tickets_sent_at?: number | null
    tickets_viewed_at?: number | null
  }
  size?: 'small' | 'medium'
}) {
  const state = deliveryState(folio)
  if (state === 'none') return null
  if (state === 'pending')
    return (
      <StatusChip tone="warning" icon={<ScheduleSendRounded />} label="Pendiente de enviar" size={size} />
    )
  if (state === 'sent')
    return <StatusChip tone="neutral" icon={<DoneRounded />} label="Enviado" size={size} />
  return <StatusChip tone="success" icon={<VisibilityRounded />} label="Visto" size={size} />
}
