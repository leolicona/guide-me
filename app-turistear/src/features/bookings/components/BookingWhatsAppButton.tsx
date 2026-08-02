import { Button, IconButton, Tooltip } from '@mui/material'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import { useClaimReminder } from '../hooks/useBookingActions'
import { useMyOrganization } from '../../organization'
import { useMe } from '../../auth/hooks/useMe'
import { formatMoney } from '../../catalog/types'
import { normalizePhone } from '../../pos/phone'

// Minimal shape the reminder flow needs — satisfied by both the agent (pos) folio rows and the
// admin folio rows/detail, so this one button serves every list surface (D5/D9).
export interface ReminderTarget {
  id: string
  customer_name?: string | null
  customer_phone?: string | null
  pending_balance?: number
  reminder_status?: 'none' | 'sent'
  reminder_sent_at?: number | null
}

// US-AG07.3 — one-tap WhatsApp recovery, surfaced directly on the existing booking card (no
// dedicated dashboard). The pre-flight atomic claim (D6) runs BEFORE opening WhatsApp so two
// viewers never both send: open only if this caller won the claim; a loser gets a non-blocking
// ¿Reenviar? (force re-claim). The icon dims once a reminder has been sent.
export function BookingWhatsAppButton({
  folio,
  variant = 'icon',
}: {
  folio: ReminderTarget
  /** `icon` = the legacy inline affordance. `card` = the labelled button US-A82 puts on FolioCard,
   *  where it is a SIBLING of the link region (D10) and can therefore be a real <button>. */
  variant?: 'icon' | 'card'
}) {
  const { data: me } = useMe()
  const { data: org } = useMyOrganization()
  const reminder = useClaimReminder()

  const reminded = folio.reminder_status === 'sent'

  const openWhatsApp = () => {
    // Shared normalizer (D3) — prepends the +52 default so a bare local number doesn't misroute.
    const phone = normalizePhone(folio.customer_phone).e164
    const name = folio.customer_name ?? 'Hola'
    const agent = me?.name ?? ''
    const orgName = org?.name ?? ''
    const pending = formatMoney(folio.pending_balance ?? 0)
    const text =
      `Hola ${name}, te escribe ${agent} de ${orgName}. Te recordamos que tu apartado tiene ` +
      `un saldo pendiente de ${pending}. Puedes liquidarlo directamente conmigo para asegurar ` +
      `tus lugares. ¡Te esperamos!`
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank')
  }

  const onClick = () => {
    reminder.mutate(
      { id: folio.id },
      {
        onSuccess: (res) => {
          if (res.claimed) {
            openWhatsApp()
          } else {
            const at = res.reminder_sent_at
              ? new Date(res.reminder_sent_at * 1000).toLocaleTimeString('es-MX', {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: org?.timezone, // US-A66 — org-local reminder time
                })
              : ''
            if (window.confirm(`Ya contactado${at ? ` a las ${at}` : ''}. ¿Reenviar?`)) {
              reminder.mutate(
                { id: folio.id, force: true },
                { onSuccess: () => openWhatsApp() },
              )
            }
          }
        },
      },
    )
  }

  // US-A82 D8 — on the card the pending job is a FILLED button with a specific verb; weight and
  // verb carry "there is work here", because presence no longer can (a card always has a button).
  // Teal, not the icon variant's success green: in this system green is a state and teal is action
  // (D9), and a green button on a green rail re-merges the two channels the redesign separated.
  if (variant === 'card') {
    return (
      // NOT fullWidth: on a 1280px list a full-bleed teal bar per pending apartado is a wall of
      // accent, and the design system reserves teal precisely so it keeps meaning something. The
      // button earns attention from its FILL against the plain-text resting verb (D8), not from
      // its width — and every other card button is content-width, so a stretched one reads as a
      // different kind of control.
      <Button
        variant="contained"
        startIcon={<WhatsAppIcon />}
        disabled={reminder.isPending || !folio.customer_phone}
        onClick={onClick}
      >
        {reminded ? 'Recordar de nuevo' : 'Recordar saldo'}
      </Button>
    )
  }

  return (
    <Tooltip title={folio.customer_phone ? 'Recordar por WhatsApp' : 'Sin teléfono'}>
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>
        <IconButton
          // Rendered as a <span> (not <button>) so it can sit INLINE next to the status chip
          // inside the card's <a> (CardActionArea) without invalid button-in-anchor nesting.
          component="span"
          size="small"
          aria-label="Recordar por WhatsApp"
          color="success"
          disabled={reminder.isPending || !folio.customer_phone}
          onClick={(e) => {
            // Used inside clickable cards — don't trigger the card's navigation.
            e.preventDefault()
            e.stopPropagation()
            onClick()
          }}
          sx={{ opacity: reminded ? 0.5 : 1 }}
        >
          <WhatsAppIcon fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  )
}
