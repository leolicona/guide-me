import { Button, Tooltip } from '@mui/material'
import { WhatsApp as WhatsAppIcon } from '@mui/icons-material'
import { isSendablePhone, normalizePhone } from '../../pos/phone'

// US-A82 D7/D8 — the card's RESTING verb: what the one button says when the folio owes no work.
// A plain text button, deliberately, so filled-versus-flat carries "there is work here" now that
// presence cannot (every card has a button).
//
// It opens an EMPTY WhatsApp compose and records NOTHING. That is the whole point of D7: this
// button and `TicketWhatsAppButton` never render on the same folio, so a seller can never send the
// portal link through a path that leaves `tickets_sent_at` unwritten — which would park the folio
// in the undelivered queue permanently, a queue growing from correct behaviour.
export function MessageWhatsAppButton({
  folio,
}: {
  folio: { customer_phone?: string | null }
}) {
  const phoneOk = isSendablePhone(folio.customer_phone)

  const open = () => {
    const phone = normalizePhone(folio.customer_phone).e164
    if (!phone) return
    window.open(`https://wa.me/${phone}`, '_blank')
  }

  return (
    <Tooltip title={phoneOk ? '' : 'Sin teléfono válido'}>
      <span style={{ display: 'inline-flex' }}>
        <Button variant="text" startIcon={<WhatsAppIcon />} disabled={!phoneOk} onClick={open}>
          Enviar mensaje
        </Button>
      </span>
    </Tooltip>
  )
}
