import { Button, Snackbar } from '@mui/material'
import { useState } from 'react'
import { CheckCircleRounded } from '@mui/icons-material'
import { useVerifyPayment, useMarkTicketsSent } from '../../bookings'
import { useMyOrganization } from '../../organization'
import { useMe } from '../../auth/hooks/useMe'
import { ticketWhatsAppUrl, DEFAULT_TICKET_TEMPLATE } from '../../pos/delivery'
import type { FolioListLine } from '../../pos/types'

// US-A84 (D13) — the card's verb for a payment awaiting verification, lifted out of the
// `PaymentVerificationTab` this feature deletes.
//
// ONE verb that finishes the job: verify, open WhatsApp with the freshly-minted portal link, stamp
// `tickets_sent_at`. Bare `Verificar` was the other candidate and it loses for a specific reason —
// it moves the folio straight out of the verification queue and into the undelivered one. A queue
// that grows from correct behaviour is the failure US-A82 D7 was written against, and offering the
// admin a verb that creates it would repeat it one screen over.
//
// `Rechazar` deliberately does NOT live here: it cancels the sale and claws back the seller's
// commission, and a destructive action one tap from a list is how the wrong folio gets cancelled
// (`pending-work-queues.spec.md` Q6, applied to a second action). It is on the folio detail.
export function VerifyAndSendButton({
  folio,
}: {
  folio: {
    id: string
    customer_name?: string | null
    customer_phone?: string | null
    total: number
    pending_balance?: number
    lines?: FolioListLine[]
  }
}) {
  const { data: org } = useMyOrganization()
  const { data: me } = useMe()
  const verify = useVerifyPayment()
  const markSent = useMarkTicketsSent('admin')
  const [toast, setToast] = useState<string | null>(null)

  const run = () =>
    verify.mutate(folio.id, {
      onSuccess: (verified) => {
        setToast('Pago verificado')
        const url = ticketWhatsAppUrl(org?.wa_ticket_template || DEFAULT_TICKET_TEMPLATE, {
          folio: verified,
          agentName: me?.name ?? '',
          orgName: org?.name ?? 'Turistear Ya!',
          portalLink: verified.portal_link ?? '',
        })
        // No dialable phone ⇒ the money is still verified and the ticket email still goes out; only
        // the WhatsApp hop is skipped. Failing the whole action there would strand the payment.
        if (url) {
          window.open(url, '_blank')
          markSent.mutate(verified.id)
        }
      },
    })

  return (
    <>
      <Button
        variant="contained"
        disableElevation
        startIcon={<CheckCircleRounded />}
        disabled={verify.isPending}
        onClick={run}
      >
        {verify.isPending ? 'Verificando…' : 'Verificar y enviar'}
      </Button>
      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        message={toast ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </>
  )
}
