import { Link as RouterLink } from 'react-router-dom'
import { Box, Card, CardActionArea, CardActions, CardContent, Chip, Divider, Stack, Typography } from '@mui/material'
import DoneRounded from '@mui/icons-material/Done'
import DoneAllRounded from '@mui/icons-material/DoneAll'
import { MoneyText } from '../../../components'
import { BookingWhatsAppButton, TicketWhatsAppButton, isUrgentBooking, venceLabel } from '../../bookings'
import { MessageWhatsAppButton } from './MessageWhatsAppButton'
import {
  folioAction,
  folioCustomerIdentity,
  folioCustomerLabel,
  folioDeliveryMark,
  folioMoneyAxis,
  folioSoldSummary,
  type DeliveryMark,
  type MoneyReading,
  type RailTone,
} from '../folioCardState'
import type { FolioStatus, RefundStatus } from '../types'
import type { FolioListLine, PaymentVerification } from '../../pos/types'

// US-A82/US-AG49 — the one folio card, shared by the admin list (/folios) and the seller's own
// (/history). Spec: docs/oversight/folio-list-scanability.spec.md.
//
// It exists as ONE component because the two pages previously inlined near-identical copies, which
// is how they came to disagree about which name to show (D13). The only real difference — who the
// byline names — is a prop, not a fork.
//
// The anatomy is D1: one channel per axis, and never two.
//   rail (left border) = money · checkmarks = message · chip = time · button = pending work
// That is the whole fix. Before it, payment state and delivery state were adjacent pills drawn from
// one four-tone palette, so a paid-and-viewed folio read "green, green" and the row had to be read
// rather than scanned.

const RAIL_COLOR: Record<RailTone, string> = {
  success: 'success.main',
  warning: 'warning.main',
  error: 'error.main',
}

/** The money figure and the words beside it (D6). One figure — a paid folio printed the same
 *  integer twice under `Total` and `Pagado`, which is noise on the element that must read first.
 *  The wording is also what gives the rail colour a text anchor, so state is never colour-alone. */
function MoneyLine({ reading }: { reading: MoneyReading }) {
  const caption = (text: string) => (
    <Typography variant="body2" color="text.secondary" component="span">
      {text}
    </Typography>
  )

  switch (reading.kind) {
    case 'paid':
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', minWidth: 0 }}>
          <MoneyText cents={reading.cents} variant="h6" srLabel="Total pagado" />
          {caption('pagado')}
        </Stack>
      )
    case 'unverified':
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', minWidth: 0 }}>
          <MoneyText cents={reading.cents} variant="h6" srLabel="Total por verificar" />
          {caption('por verificar')}
        </Stack>
      )
    case 'owing':
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', minWidth: 0 }}>
          {caption('Debe')}
          <MoneyText cents={reading.paid} variant="h6" srLabel="Saldo pendiente" />
          {caption(`de ${(reading.total / 100).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`)}
        </Stack>
      )
    case 'refundOwed':
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', minWidth: 0 }}>
          {caption('Reembolsar')}
          <MoneyText cents={reading.cents} variant="h6" semantic="negative" srLabel="Reembolso pendiente" />
        </Stack>
      )
    case 'refundSettled':
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', minWidth: 0 }}>
          <MoneyText cents={reading.cents} variant="h6" sx={{ color: 'text.secondary' }} srLabel="Total" />
          {caption('(reembolsado)')}
        </Stack>
      )
  }
}

/** The message axis (D11). Two marks and never three: `✓` = the seller opened the composer,
 *  `✓✓` = the tourist's browser fired the portal beacon. WhatsApp's middle "delivered" tick is
 *  omitted on purpose — no column here backs that claim. The label is real text for a screen
 *  reader, because a glyph alone is not state. */
function DeliveryMarkIcon({ mark }: { mark: DeliveryMark }) {
  if (mark === 'none') return null
  const viewed = mark === 'viewed'
  return (
    <Box
      component="span"
      role="img"
      aria-label={viewed ? 'Boletos vistos por el cliente' : 'Boletos enviados'}
      sx={{ display: 'inline-flex', color: viewed ? 'success.main' : 'text.disabled', flexShrink: 0 }}
    >
      {viewed ? <DoneAllRounded fontSize="small" /> : <DoneRounded fontSize="small" />}
    </Box>
  )
}

/**
 * The subset both list rows satisfy — the admin `FolioListItem` and the seller `FolioHistoryItem`.
 * Structural, like `ReminderTarget`, so one card serves both surfaces without either page casting
 * its own row into the other's type.
 */
export interface FolioCardFolio {
  id: string
  status: FolioStatus
  customer_name?: string | null
  customer_phone?: string | null
  total: number
  amount_paid: number
  pending_balance?: number
  booking_expires_at?: number | null
  reminder_status?: 'none' | 'sent'
  reminder_sent_at?: number | null
  payment_verification?: PaymentVerification
  refund_status?: RefundStatus
  refund_amount?: number | null
  payment_reference?: string | null
  deliverable?: boolean
  portal_link?: string | null
  tickets_sent_at?: number | null
  tickets_viewed_at?: number | null
  lines?: FolioListLine[]
}

export interface FolioCardProps {
  folio: FolioCardFolio
  /** Where the info region navigates — the admin detail or the seller's read-only one. */
  to: string
  /** Who the row is attributed to. Admin lists name the agent; a seller's own list names the shift
   *  operator (D13), and a direct sale passes `null` so the line simply collapses. */
  byline?: string | null
  /** Org-local sale timestamp, already formatted by the page's `useOrgDateFormatter`. */
  soldAt: string
  /** `admin` marks the send through the admin endpoint; `seller` through the POS one. */
  surface?: 'admin' | 'seller'
}

export function FolioCard({ folio, to, byline, soldAt, surface = 'admin' }: FolioCardProps) {
  const { rail, reading } = folioMoneyAxis(folio)
  const sold = folioSoldSummary(folio.lines)
  const mark = folioDeliveryMark(folio)
  const isBooking = folio.status === 'booking'
  const urgent = isBooking && isUrgentBooking(folio.booking_expires_at)
  const action = folioAction(folio, { urgent })

  const title = sold.name
    ? [sold.name, sold.when, sold.more > 0 ? `+${sold.more}` : ''].filter(Boolean).join(' · ')
    : 'Venta sin detalle'

  const who = folioCustomerIdentity(folio)
  // The rest of the identity line is plain text; only the mask needs its own tracking.
  const restOfIdentity = [byline || '', soldAt].filter(Boolean).join(' · ')

  return (
    <Card variant="outlined" sx={{ borderLeftWidth: 4, borderLeftColor: RAIL_COLOR[rail] }}>
      {/* D10 — the link region and the action are SIBLINGS. The card used to be one <a> with a
          button inside it, which is invalid nesting and forced two different workarounds
          (component="span" here, stopPropagation there). As siblings both are real focus stops. */}
      <CardActionArea component={RouterLink} to={to}>
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
            {title}
          </Typography>
          {/* The mask's bullets get their OWN tracking. Manrope gives `•` enough side bearing that
              `••5678` renders as `• •5678` — which reads as a typo, not as a masked number. The
              whole caption cannot simply be tightened: at −0.12em the names crush. `aria-label`
              carries the label form so a screen reader hears one identity, not stray bullets. */}
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ display: 'block' }}
            aria-label={`${folioCustomerLabel(folio)}${restOfIdentity ? ` · ${restOfIdentity}` : ''}`}
          >
            <Box component="span" aria-hidden>
              {who.kind === 'name' ? (
                who.text
              ) : who.kind === 'masked' ? (
                <>
                  Cliente{' '}
                  <Box component="span" sx={{ letterSpacing: '-0.16em', mr: '0.16em' }}>
                    ••
                  </Box>
                  {who.tail}
                </>
              ) : (
                'Cliente'
              )}
              {restOfIdentity ? ` · ${restOfIdentity}` : ''}
            </Box>
          </Typography>
          {/* The reference is what an admin matches against the bank statement, so it belongs on
              the row that says the money has not landed — not one tap away. */}
          {reading.kind === 'unverified' && folio.payment_reference && (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
              Ref. {folio.payment_reference}
            </Typography>
          )}
          {isBooking && folio.booking_expires_at != null && (
            <Chip
              size="small"
              variant="outlined"
              color={urgent ? 'warning' : 'default'}
              label={venceLabel(folio.booking_expires_at)}
              sx={{ mt: 0.5, display: 'flex', width: 'fit-content' }}
            />
          )}
          <Divider sx={{ my: 1.5 }} />
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', justifyContent: 'space-between' }}
          >
            <MoneyLine reading={reading} />
            <DeliveryMarkIcon mark={mark} />
          </Stack>
        </CardContent>
      </CardActionArea>
      <CardActions sx={{ px: 2, pb: 2, pt: 0 }}>
        {action === 'tickets' ? (
          <TicketWhatsAppButton
            variant="card"
            surface={surface}
            // The template context wants the fields present, not merely optional — `{customer_name}`
            // must degrade to an empty greeting rather than the string "undefined".
            folio={{
              ...folio,
              customer_name: folio.customer_name ?? null,
              customer_phone: folio.customer_phone ?? null,
              lines: folio.lines ?? [],
            }}
          />
        ) : action === 'reminder' ? (
          <BookingWhatsAppButton variant="card" folio={folio} />
        ) : (
          <MessageWhatsAppButton folio={folio} />
        )}
      </CardActions>
    </Card>
  )
}
