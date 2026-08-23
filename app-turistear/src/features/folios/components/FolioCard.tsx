import { Link as RouterLink } from 'react-router-dom'
import { Box, Button, Card, CardActionArea, CardActions, CardContent, Chip, Divider, Stack, Typography } from '@mui/material'
import DoneRounded from '@mui/icons-material/Done'
import DoneAllRounded from '@mui/icons-material/DoneAll'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import { MoneyText } from '../../../components'
import { BookingWhatsAppButton, TicketWhatsAppButton, isUrgentBooking } from '../../bookings'
import { MessageWhatsAppButton } from './MessageWhatsAppButton'
import { VerifyAndSendButton } from './VerifyAndSendButton'
import {
  folioAction,
  folioCustomerIdentity,
  folioCustomerLabel,
  folioDeliveryMark,
  folioAttention,
  folioMoneyAxis,
  folioSoldSummary,
  folioTimeChip,
  type DeliveryMark,
  type MoneyReading,
  type RailTone,
  type TimeChipTone,
} from '../folioCardState'
import type { CancellationRequestMark, FolioStatus, Fulfillment, RefundStatus } from '../types'
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

// D14 (line-autonomy) — the per-line mark on a MIXED folio: icon + word + functional colour,
// never colour alone (DESIGN_TOKENS §3). Same vocabulary as FolioStatusChip.
const LINE_MARK: Record<
  'paid' | 'booking' | 'cancelled',
  { label: string; color: string; icon: React.ReactNode }
> = {
  paid: { label: 'Pagado', color: 'success.main', icon: <CheckCircleRounded sx={{ fontSize: 14 }} /> },
  booking: { label: 'Apartado', color: 'warning.main', icon: <ScheduleRounded sx={{ fontSize: 14 }} /> },
  cancelled: { label: 'Cancelado', color: 'error.main', icon: <BlockRounded sx={{ fontSize: 14 }} /> },
}

/** The money figure and the words beside it (D6). One figure — a paid folio printed the same
 *  integer twice under `Total` and `Pagado`, which is noise on the element that must read first.
 *  The wording is also what gives the rail colour a text anchor, so state is never colour-alone. */
function MoneyLine({ reading }: { reading: MoneyReading }) {
  const caption = (text: string) => (
    <Typography variant="body2" color="textSecondary" component="span">
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
          <MoneyText cents={reading.cents} variant="h6" sx={{ color: 'text.secondary' }} srLabel="Reembolsado" />
          {caption('(reembolsado)')}
        </Stack>
      )
    // BUG-027 — cancelled and owed nothing back. It used to render here as "(reembolsado)", about
    // money the organization kept. The figure is what the customer PAID, because that is the sum
    // the retention was taken out of; the caption is what happened to it.
    // US-A87 — the credit, on the axis money already owns. Load-bearing while the checkout cannot
    // apply it automatically: the way an agent honours it is the manual discount they already have,
    // and an agent who cannot SEE the credit cannot decide to honour it.
    case 'credit':
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', minWidth: 0 }}>
          {caption('A favor')}
          <MoneyText cents={reading.cents} variant="h6" semantic="positive" srLabel="Saldo a favor" />
        </Stack>
      )
    case 'refundNone':
      return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', minWidth: 0 }}>
          <MoneyText cents={reading.cents} variant="h6" sx={{ color: 'text.secondary' }} srLabel="Pagado, sin reembolso" />
          {caption('(sin reembolso)')}
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
  /** US-A85 — the folio's roll-up; the time chip renders it once the departure has passed. */
  fulfillment?: Fulfillment
  refund_amount?: number | null
  /** US-A87 — what a closed apartado left the customer. */
  credit_amount?: number | null
  payment_reference?: string | null
  deliverable?: boolean
  portal_link?: string | null
  tickets_sent_at?: number | null
  tickets_viewed_at?: number | null
  lines?: FolioListLine[]
  // US-A84 — the two states the row could not carry before, and the debt's clock.
  cancellation_request?: CancellationRequestMark | null
  cancelled_at?: number | null
}

/** US-A84 — the time channel's tone, mapped to MUI's chip colours. `default` is the grey resting
 *  state; a passed deadline or an owed refund is a fact about the past, so it reads ERROR rather
 *  than the amber `venceLabel` used to draw it in. */
const CHIP_COLOR: Record<TimeChipTone, 'default' | 'warning' | 'error'> = {
  default: 'default',
  warning: 'warning',
  error: 'error',
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
  /**
   * US-A84 D19 — the current time, resolved in an EFFECT by the page's `useNowSeconds` and passed
   * in. Never read from `Date.now()` inside this render: the chip now says *how long ago*, and a
   * booth tablet left open all morning would print a dead number. `null` until it resolves.
   */
  nowSeconds?: number | null
  /** `admin` marks the send through the admin endpoint; `seller` through the POS one. It also
   *  decides which VERBS are offered: US-A84 D15 draws the audience line at capability. */
  surface?: 'admin' | 'seller'
}

export function FolioCard({
  folio,
  to,
  byline,
  soldAt,
  nowSeconds = null,
  surface = 'admin',
}: FolioCardProps) {
  const { reading } = folioMoneyAxis(folio)
  const sold = folioSoldSummary(folio.lines)
  const mark = folioDeliveryMark(folio)
  const isBooking = folio.status === 'booking'
  const urgent = isBooking && isUrgentBooking(folio.booking_expires_at)
  const action = folioAction(folio, { urgent, surface })
  // D14 (line-autonomy) — the rail is the ATTENTION semaphore. BUG-035 / parity D17: it is
  // computed WITHOUT the surface, because "does this folio need a human?" is a fact about the
  // folio; only the button below filters by who is reading. The money reading keeps its own
  // semantics untouched.
  const { rail } = folioAttention(folio, { urgent })
  // The petition is the one state whose words the seller never got: an unverified transfer already
  // reads «por verificar» on the money line and an owed refund reads «Reembolsar», but a customer
  // waiting on an answer had no text at all once its admin verb was filtered away. Rendered only
  // where the button is NOT already naming it, so the admin never reads the same fact twice.
  const petitionMark = folio.cancellation_request === 'pending' && action !== 'request'
  const timeChip = folioTimeChip(folio, nowSeconds)
  // D14 — a MIXED folio names its lines: one mark per line, icon-paired, only when the states
  // actually differ (a uniform folio stays quiet).
  const lineMarks = (folio.lines ?? []).filter((l) => l.money_state)
  const mixed = new Set(lineMarks.map((l) => l.money_state)).size > 1

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
          {/* The row's name is the list item's heading — `h2` under the page's «Ventas» `h1`, so
              a screen reader can jump card to card. It used to be an `<h6>` by accident of the
              variant mapping, alongside the price beside it. */}
          <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }} noWrap>
            {title}
          </Typography>
          {/* The mask's bullets get their OWN tracking. Manrope gives `•` enough side bearing that
              `••5678` renders as `• •5678` — which reads as a typo, not as a masked number. The
              whole caption cannot simply be tightened: at −0.12em the names crush. `aria-label`
              carries the label form so a screen reader hears one identity, not stray bullets. */}
          <Typography
            variant="caption"
            color="textSecondary"
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
            <Typography variant="caption" color="textSecondary" noWrap sx={{ display: 'block' }}>
              Ref. {folio.payment_reference}
            </Typography>
          )}
          {/* BUG-035 — the request, in words, on the surface whose button cannot name it.
              Icon-paired functional colour (DESIGN_TOKENS §3): the amber rail beside it must never
              be the only thing saying this sale needs someone. */}
          {petitionMark && (
            <Typography
              variant="caption"
              noWrap
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                mt: 0.5,
                color: 'warning.main',
                fontWeight: 600,
              }}
            >
              <EventBusyRounded sx={{ fontSize: 14 }} />
              El cliente pidió un cambio
            </Typography>
          )}
          {/* The time channel (D1). One chip, whichever clock this folio is running against: the
              hold's deadline, or — once cancelled with money owed — the age of the debt. US-A84
              D10 moved that age here from the queues' sort order, so it survives a list that has
              exactly one order. */}
          {timeChip && (
            <Chip
              size="small"
              variant="outlined"
              color={CHIP_COLOR[timeChip.tone]}
              label={timeChip.label}
              sx={{ mt: 0.5, display: 'flex', width: 'fit-content' }}
            />
          )}
          {/* D14 (line-autonomy) — a MIXED folio names its lines, one icon-paired mark each: the
              detail's truth, at a glance, only where the states differ. */}
          {mixed && (
            <Stack spacing={0.25} sx={{ mt: 0.5 }}>
              {lineMarks.map((l, i) => (
                <Typography
                  key={l.id ?? i}
                  variant="caption"
                  noWrap
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    color: LINE_MARK[l.money_state!].color,
                    fontWeight: 600,
                  }}
                >
                  {LINE_MARK[l.money_state!].icon}
                  {l.service_name} — {LINE_MARK[l.money_state!].label}
                </Typography>
              ))}
            </Stack>
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
      {/* US-A84 D12 — exactly one verb, and it is the first BLOCKING job. `request` and `refund`
          navigate to the detail rather than acting here: approving a cancellation and confirming a
          refund against the customer's PIN both need the full folio in front of you, and a money
          action one tap from a list is how the wrong one gets confirmed (Q6). */}
      <CardActions sx={{ px: 2, pb: 2, pt: 0 }}>
        {action === 'request' ? (
          <Button
            component={RouterLink}
            to={to}
            variant="contained"
            disableElevation
            color="error"
            startIcon={<EventBusyRounded />}
          >
            Revisar solicitud
          </Button>
        ) : action === 'verify' ? (
          <VerifyAndSendButton folio={{ ...folio, lines: folio.lines ?? [] }} />
        ) : action === 'refund' ? (
          <Button
            component={RouterLink}
            to={to}
            variant="contained"
            disableElevation
            color="error"
            startIcon={<PaymentsRounded />}
          >
            Confirmar reembolso
          </Button>
        ) : action === 'tickets' ? (
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
