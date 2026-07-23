import { Button, IconButton, Tooltip } from '@mui/material'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import { useMarkTicketsSent } from '../hooks/useBookingActions'
import { useMyOrganization } from '../../organization'
import { useMe } from '../../auth/hooks/useMe'
import { isSendablePhone } from '../../pos/phone'
import { ticketWhatsAppUrl, DEFAULT_TICKET_TEMPLATE, type TemplateContext } from '../../pos/delivery'

type DeliverableFolio = TemplateContext['folio'] & { portal_link?: string | null }

// The agent-driven ticket send (whatsapp-qr-delivery). Builds wa.me from the org's ticket template
// (or the shipped default) + the portal link, opens the agent's own WhatsApp, then records the send
// (D13 — simple idempotent mark, no claim). `variant`: 'primary' = the big receipt CTA; 'icon' = the
// list/detail affordance. `surface` picks the seller vs. admin mark endpoint.
export function TicketWhatsAppButton({
  folio,
  surface = 'seller',
  variant = 'primary',
  agentName,
  onSent,
}: {
  folio: DeliverableFolio
  surface?: 'seller' | 'admin'
  variant?: 'primary' | 'icon'
  agentName?: string
  onSent?: () => void
}) {
  const { data: org } = useMyOrganization()
  const { data: me } = useMe()
  const mark = useMarkTicketsSent(surface)

  const portalLink = folio.portal_link ?? ''
  const phoneOk = isSendablePhone(folio.customer_phone)
  const disabled = !portalLink || !phoneOk || mark.isPending

  const send = () => {
    if (disabled) return
    const template = org?.wa_ticket_template || DEFAULT_TICKET_TEMPLATE
    const url = ticketWhatsAppUrl(template, {
      folio,
      agentName: agentName ?? me?.name ?? '',
      orgName: org?.name ?? 'Turistear Ya!',
      portalLink,
    })
    if (url) window.open(url, '_blank')
    // Optimistic accountability: record the send regardless (D13). The tourist opening the portal
    // later flips it to "Visto" via the beacon.
    mark.mutate(folio.id, { onSuccess: () => onSent?.() })
  }

  const tip = !portalLink
    ? 'Los boletos aún no están listos'
    : !phoneOk
      ? 'Sin teléfono válido'
      : 'Enviar boletos por WhatsApp'

  if (variant === 'icon') {
    return (
      <Tooltip title={tip}>
        <span style={{ display: 'inline-flex' }}>
          <IconButton
            aria-label="Enviar boletos por WhatsApp"
            color="success"
            size="small"
            disabled={disabled}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              send()
            }}
          >
            <WhatsAppIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    )
  }

  return (
    <Tooltip title={disabled && portalLink ? tip : ''}>
      <span style={{ display: 'block' }}>
        <Button
          fullWidth
          size="large"
          variant="contained"
          startIcon={<WhatsAppIcon />}
          disabled={disabled}
          onClick={send}
        >
          Enviar boletos por WhatsApp
        </Button>
      </span>
    </Tooltip>
  )
}
