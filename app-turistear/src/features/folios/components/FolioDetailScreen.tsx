import { useState } from 'react'
import type { FormEvent } from 'react'
import { useParams, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Collapse,
  Fade,
  Stack,
  Divider,
  Chip,
  IconButton,
  TextField,
  FormControlLabel,
  Switch,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import ExpandLessRounded from '@mui/icons-material/ExpandLessRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import { useFolio, useCancelFolio, useCancelFolioLine, useConfirmRefund } from '../hooks'
import { useNowSeconds } from '../hooks/useNowSeconds'
import { folioTimeChip } from '../folioCardState'
import { FolioMoneyOutcome } from './FolioMoneyOutcome'
import { FolioStatusChip } from './FolioStatusChip'
import { FolioTimeline } from './FolioTimeline'
import { refundReceiptUrl } from '../refundReceipt'
import { FolioWorkActions } from './FolioWorkActions'
import type { FolioDetail } from '../types'
import { useOrgDateFormatter } from '../../organization'
import type { CancellationQuote } from '../../organization/types'
// US-A93 (folio-surface-parity D1) — the seller's read of the SAME folio, through their own
// caller-scoped endpoint. Since #126 both endpoints return the same payload, so everything below
// this line is one code path.
import { useFolioDetailRead } from '../../pos/hooks'
import { TicketQr } from '../../pos/components/TicketQr'
import BlockRounded from '@mui/icons-material/BlockRounded'
import RemoveDoneRounded from '@mui/icons-material/RemoveDoneRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import PhoneRounded from '@mui/icons-material/PhoneRounded'
import MailOutlineRounded from '@mui/icons-material/MailOutlineRounded'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import { isSendablePhone, normalizePhone } from '../../pos/phone'
import { BookingActions } from '../../bookings'
import { ServiceError } from '../../../services/authService'
import { formatMoney } from '../../catalog/types'
import { folioLineMeta } from '../folioLineLabel'
import { ConfirmSheet, FormSheet, MoneyText, SectionCard, StatusChip } from '../../../components'
import { ROUTES } from '../../../config/routes'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// US-A85 — what a line says about whether it was used. Functional color, icon-paired (state is
// never color-alone), and only when there is something to say: a line still ahead of its
// departure says nothing, because "not used yet" is not a fact about the sale. Never teal.
const lineFulfillmentNote = (line: { fulfillment?: string; quantity: number; redeemed_count?: number }) => {
  if (line.fulfillment === 'no_show') {
    return { text: 'Nadie usó estos lugares', color: 'error.main', Icon: BlockRounded }
  }
  if (line.fulfillment === 'partial') {
    return {
      text: `Usaron ${line.redeemed_count ?? 0} de ${line.quantity}`,
      color: 'warning.main',
      Icon: RemoveDoneRounded,
    }
  }
  if (line.fulfillment === 'fulfilled') {
    return { text: 'Usado', color: 'success.main', Icon: CheckCircleRounded }
  }
  return null
}

export interface FolioDetailScreenProps {
  /** Which audience is reading. It decides the READ (the admin's org-wide endpoint or the seller's
   *  caller-scoped one) and the VERBS — nothing else. Both endpoints return the same payload
   *  since #126, so no field below is surface-dependent (D6/D13). */
  surface: 'admin' | 'seller'
}

export function FolioDetailScreen({ surface }: FolioDetailScreenProps) {
  const isAdmin = surface === 'admin'
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
  const { id } = useParams<{ id: string }>()
  // Both hooks run every render (rules of hooks); passing `undefined` disables the one this
  // surface is not using, since both queries are `enabled: !!id`.
  const adminRead = useFolio(isAdmin ? id : undefined)
  const sellerRead = useFolioDetailRead(isAdmin ? undefined : id)
  const { data, isLoading, isError } = isAdmin ? adminRead : sellerRead
  const folio = data?.folio
  // US-A84 D19 — the clock resolves in an effect, never `Date.now()` in render: this page sits
  // open while an admin works, and a countdown frozen at load time is a wrong screen.
  const nowSeconds = useNowSeconds()
  // US-A69 — what cancelling right now would cost, priced by the org's ladder. Every org has one
  // (D17), so this is null only for a folio that is already cancelled: nothing left to quote.
  const quote = data?.quote ?? null
  const cancel = useCancelFolio()
  const cancelLine = useCancelFolioLine()
  const refund = useConfirmRefund()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reason, setReason] = useState('')
  // US-A22 — the line being cancelled (null = sheet closed) + its optional note.
  const [lineTarget, setLineTarget] = useState<FolioDetail['lines'][number] | null>(null)
  const [lineReason, setLineReason] = useState('')
  // US-A23 / US-T05 — refund confirmation dialog: PIN (primary) or no-PIN override + note.
  const [refundOpen, setRefundOpen] = useState(false)
  // US-A93 (D8) — the tickets are INFORMATION, so both audiences get them; only the default
  // differs. The seller shows the customer the QR at the counter, so it opens; the admin's daily
  // reading of this screen is money and pending work, so it waits until they ask for it.
  const [qrOpen, setQrOpen] = useState(!isAdmin)
  const [pin, setPin] = useState('')
  const [useOverride, setUseOverride] = useState(false)
  const [overrideNote, setOverrideNote] = useState('')

  const isCancelled = folio?.status === 'cancelled'
  // US-AG07/D5 — a live apartado: it gets the booking actions instead of the US-A21 cancel.
  const isBooking = folio?.status === 'booking'
  // The D12 ladder itself lives inside `FolioWorkActions` now (one component, one rung). These
  // two flags remain only to park the ACTION BLOCK at the bottom: an open petition parks every
  // verb — resolving it IS the path (approving cancels priced by the ladder; rejecting unblocks),
  // and a counter action alongside it would orphan the petition against a folio that already
  // moved. Unverified money parks the cancel too: US-A21 would run the ladder over an amount the
  // company never confirmed and mint a refund PIN for it (BUG-030) — `Rechazar pago` is the
  // cancel path for unconfirmed money.
  const hasOpenPetition = !!folio?.folio_requests?.some((r) => r.status === 'pending')
  const awaitingVerification = folio?.payment_verification === 'pending' && !isCancelled
  // Every dated line already departed → the folio is a countable fact (its fulfilment reading),
  // not something to cancel: no seats to release, terminal-tier money. Client-clock pre-filter,
  // date granularity — the same call BookingActions makes for its movable lines.
  const todayIso = new Date().toISOString().slice(0, 10)
  const allDeparted =
    !!folio &&
    (folio.lines?.length ?? 0) > 0 &&
    folio.lines.every((l) => l.slot_date && l.slot_date < todayIso)
  // The same time channel the list card derives — one clock, whichever the folio runs against.
  const timeChip = folio ? folioTimeChip(folio, nowSeconds) : null

  const closeDialog = () => {
    setConfirmOpen(false)
    setReason('')
  }

  const handleCancel = () => {
    if (!id) return
    // D10 — nothing else to send. The refund and the commission outcome are the ladder's, so the
    // dialog collects a note and confirms a number it did not compute.
    cancel.mutate({ id, reason: reason.trim() || undefined }, { onSuccess: closeDialog })
  }

  // US-A22 (line-autonomy F2) — cancel ONE activity. The gesture is offered only where it is
  // honest: an active PAID folio (an apartado keeps its own verbs until F3's per-line settle), a
  // line still ahead of its departure, never an already-cancelled line, and never the LAST live
  // one — cancelling everything is `Cancelar folio`, whose sheet quotes the whole.
  const liveLines = folio?.lines?.filter((l) => l.cancelled_at == null) ?? []
  const canCancelLine = (line: FolioDetail['lines'][number]): boolean =>
    isAdmin &&
    !!folio &&
    !isCancelled &&
    !isBooking &&
    !awaitingVerification &&
    !hasOpenPetition &&
    line.cancelled_at == null &&
    liveLines.length > 1 &&
    (line.slot_date ?? line.check_in ?? '') >= todayIso

  const closeLineDialog = () => {
    setLineTarget(null)
    setLineReason('')
  }
  const handleCancelLine = () => {
    if (!id || !lineTarget) return
    cancelLine.mutate(
      { id, lineId: lineTarget.id, reason: lineReason.trim() || undefined },
      { onSuccess: closeLineDialog },
    )
  }
  // The subset quote for the sheet — computed server-side (line_refund rides the folio quote),
  // never derived here: the number shown is the number the endpoint will write.
  const lineQuote = quote?.lines.find((l) => l.line_id === lineTarget?.id) ?? null

  const openRefundDialog = () => {
    setPin('')
    setUseOverride(false)
    setOverrideNote('')
    refund.reset()
    setRefundOpen(true)
  }

  // Opens the composer with the receipt pre-filled. The message itself is a pure function
  // (`refundReceipt.ts`) so the three figures it must contain are testable without a page.
  const openRefundReceipt = (f: FolioDetail | undefined) => {
    const url = f && refundReceiptUrl(f)
    if (url) window.open(url, '_blank')
  }

  // FormSheet wires this to a real <form>, so Enter in the PIN field submits too — the guard
  // repeats the footer's disabled condition because implicit submission does not check it.
  const handleRefundSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!id || refundSubmitDisabled) return
    const input = useOverride
      ? { override_note: overrideNote.trim() }
      : { pin: pin.trim() }
    // US-AG51 (D12/D20) — the action does not end when the sheet closes; it ends when the customer
    // has been told. This used to stop at `setRefundOpen(false)` and nobody was notified — the
    // pattern that works already existed one screen away (`Verificar y enviar`).
    //
    // The receipt is the record the customer keeps: cash was handed over in person with no paper,
    // and the retention arithmetic — *paid 3,000, received 1,800* — is shown to them nowhere else.
    refund.mutate(
      { id, input },
      {
        onSuccess: (updated) => {
          setRefundOpen(false)
          openRefundReceipt(updated ?? folio)
        },
      },
    )
  }

  const refundSubmitDisabled =
    refund.isPending || (useOverride ? !overrideNote.trim() : !pin.trim())

  // 422 = wrong PIN; 409 = locked after too many failures (or nothing pending).
  const refundErrorMessage =
    refund.error instanceof ServiceError && refund.error.status === 422
      ? 'PIN incorrecto. Verifica el código que te dio el cliente.'
      : refund.error instanceof ServiceError && refund.error.status === 409
        ? 'El PIN se bloqueó tras demasiados intentos — confirma con nota de respaldo.'
        : 'No se pudo confirmar el reembolso. Inténtalo de nuevo.'

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 640, mx: 'auto' }}>
        <Button
          component={RouterLink}
          to={isAdmin ? ROUTES.FOLIOS : ROUTES.HISTORY}
          startIcon={<ArrowBackRounded />}
          sx={{ mb: 2 }}
        >
          {/* US-UX07 — one word. The two back buttons used to say «Folios» and «Historial», and
              the screens they return to are both titled «Ventas». */}
          Ventas
        </Button>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && <Alert severity="error">No se pudo cargar esta venta. Inténtalo de nuevo.</Alert>}

        {folio && (
          <Stack spacing={3}>
            {/* Stacked header: title → meta → ONE chip row. A side-by-side layout gave the
                natural-width chips 273 of 343px and squeezed the title to 69 (design review,
                Must Fix 1-3); stacking lets the name breathe and the chips wrap. */}
            <Box>
              <Typography
                variant="h5"
                component="h1"
                sx={{
                  // Two lines then ellipsis — never a one-line chop to "E2E …". The right
                  // padding keeps the first line clear of the fixed avatar chip on mobile.
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  pr: { xs: 7, md: 0 },
                }}
              >
                {folio.customer_name ?? 'Sin nombre'}
              </Typography>
              {/* The header IS the customer's card: who they are and how to reach them, one
                  container, one subject. The sale's provenance (who sold it, when) moved to the
                  payment card — it is a fact about the sale, not about the customer. Contact used
                  to sit inside the payment card, where one shared border made a phone number
                  parse as sale data. */}
              {folio.customer_phone && (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <PhoneRounded sx={{ fontSize: 16, color: 'text.secondary' }} />
                  <Typography
                    variant="body2"
                    component="a"
                    href={`tel:${folio.customer_phone}`}
                    sx={{ color: 'text.primary', textDecoration: 'none' }}
                  >
                    {folio.customer_phone}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  {/* Continuous contact lives WITH the contact, not in the work card: the rain
                      call — notify, negotiate, then decide — needs no pending action to exist.
                      Empty compose; records nothing (US-A82 D7). */}
                  {isSendablePhone(folio.customer_phone) && (
                    <IconButton
                      aria-label="Enviar mensaje por WhatsApp"
                      onClick={() => {
                        const phone = normalizePhone(folio.customer_phone).e164
                        if (phone) window.open(`https://wa.me/${phone}`, '_blank')
                      }}
                      sx={{ width: 48, height: 48, color: 'primary.main' }}
                    >
                      <WhatsAppIcon />
                    </IconButton>
                  )}
                </Stack>
              )}
              {folio.customer_email && (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <MailOutlineRounded sx={{ fontSize: 16, color: 'text.secondary' }} />
                  <Typography variant="body2" color="text.primary">
                    {folio.customer_email}
                  </Typography>
                </Stack>
              )}
              {/* One StatusChip per active axis in a FIXED order — money · clearance · debt ·
                  time — so the eye learns one position per axis (the list's one-channel-per-axis
                  logic). An axis at its default value says nothing here. The time chip derives
                  from useNowSeconds (D19), never Date.now() in render. */}
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
                <FolioStatusChip status={folio.status} />
                {folio.payment_verification === 'pending' && (
                  <StatusChip status="pending" label="Por verificar" />
                )}
                {/* US-A23 — refund status at a glance, next to the folio status. */}
                {folio.refund_status === 'pending' && (
                  <StatusChip status="pending" label="Reembolso pendiente" />
                )}
                {folio.refund_status === 'refunded' && (
                  <StatusChip status="paid" label="Reembolsado" />
                )}
                {timeChip && (
                  <Chip
                    size="small"
                    variant="outlined"
                    color={timeChip.tone}
                    label={timeChip.label}
                  />
                )}
              </Stack>
            </Box>

            {/* No banner zone survives here: past facts live in the Historial, state in the
                chips, money in the payment card, and every warning that carries a button is a
                RUNG of the pending-action card below. `ExpiredBookingBanner` retired last — its
                credit instruction now rides the "Saldo a favor" row it was about. */}

            {/* US-A84 (D14/D21) — THE pending-action card: the whole D12 ladder (solicitud →
                verificación → reembolso → entrega) resolved inside, exactly one rung rendered.
                Renders nothing when this folio needs nothing. */}
            <FolioWorkActions folio={folio} onConfirmRefund={openRefundDialog} surface={surface} />

            {/* US-A24 — the sale as a story, COLLAPSED between the state and the money so context
                reads first without pushing the dominant figure down (money reads first — law #1).
                Rejected petitions interleave as derived rows: one Historial, not two. */}
            <FolioTimeline
              events={data?.events}
              lines={folio.lines}
              fulfillment={folio.fulfillment}
              requests={folio.folio_requests}
              refundNote={folio.refund_note}
              collapsible
            />

            {/* `SectionCard` rather than a raw `Card` — the design system's resting surface
                (hairline border, 16px radius, 24px padding, no shadow). Both details rendered a
                bare `<Card><CardContent>` here, which `CLAUDE.md` asks us not to. */}
            <SectionCard>
              <Box>
                {/* The payment card is the SALE — and this caption is its letterhead: who sold
                    it, when. It moved here from the header (a fact about the sale, not the
                    customer), caption-weight so the lines and the Total keep the hierarchy —
                    money reads first. The Historial's `confirmed_sale` row carries the same fact
                    as narrative; this is the at-a-glance read. */}
                <Typography variant="caption" color="text.secondary">
                  Vendido por {folio.agent.name}
                  {/* US-A68 — the affiliate shift operator who took the sale, when applicable. */}
                  {folio.operator_name ? ` (op. ${folio.operator_name})` : ''} ·{' '}
                  {formatDate(folio.created_at)}
                </Typography>
                <Divider sx={{ my: 2 }} />

                <Stack spacing={2} divider={<Divider flexItem />}>
                  {folio.lines.map((line) => {
                    // US-A85 (D2) — fulfilment lives on the LINE, and the detail is the only
                    // place the breakdown can be read: "the Tuesday tour was used, nobody came
                    // to Thursday's". The card shows only the worst of them.
                    const note = lineFulfillmentNote(line)
                    return (
                    <Stack
                      key={line.id}
                      direction="row"
                      sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Typography variant="subtitle2">{line.service_name}</Typography>
                          {/* US-A22 — the line's OWN state, shown only when it differs from the
                              folio's: a uniform folio stays quiet; a mixed one names the odd one
                              out. Same chip, same vocabulary — no second presentation invented. */}
                          {line.money_state && line.money_state !== folio.status && (
                            <FolioStatusChip status={line.money_state} />
                          )}
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          {folioLineMeta(line)} · {formatMoney(line.unit_price)}
                        </Typography>
                        {note && (
                          <Typography
                            variant="caption"
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 0.5,
                              color: note.color,
                              fontWeight: 600,
                            }}
                          >
                            <note.Icon sx={{ fontSize: 14 }} />
                            {note.text}
                          </Typography>
                        )}
                        {/* US-A22 — a cancelled line states its own money outcome, the same
                            "Se devuelve / retiene" language the folio-level record uses. */}
                        {line.cancelled_at != null && line.refund_status === 'pending' && (
                          <Typography
                            variant="caption"
                            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'warning.main', fontWeight: 600 }}
                          >
                            <ScheduleRounded sx={{ fontSize: 14 }} />
                            Se devuelve {formatMoney(line.refund_amount ?? 0)} — por entregar
                          </Typography>
                        )}
                        {line.cancelled_at != null && line.refund_status === 'refunded' && (
                          <Typography
                            variant="caption"
                            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'success.main', fontWeight: 600 }}
                          >
                            <CheckCircleRounded sx={{ fontSize: 14 }} />
                            Reembolso de {formatMoney(line.refund_amount ?? 0)} entregado
                          </Typography>
                        )}
                        {line.extras.map((e) => (
                          <Typography
                            key={e.id}
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block' }}
                          >
                            + {e.quantity}× {e.name} ({formatMoney(e.price)})
                          </Typography>
                        ))}
                        {/* US-A22 — cancel THIS activity alone. Only where the gesture is honest:
                            an active paid folio, a line still ahead of its departure, and never
                            the last live line — cancelling everything is `Cancelar venta`, whose
                            sheet quotes the whole. Apartados keep their own verbs (F3). */}
                        {canCancelLine(line) && (
                          <Button
                            size="small"
                            color="error"
                            sx={{ px: 0, minWidth: 0, mt: 0.25 }}
                            onClick={() => setLineTarget(line)}
                          >
                            Cancelar esta actividad
                          </Button>
                        )}
                      </Box>
                      <Typography variant="subtitle2">{formatMoney(line.line_total)}</Typography>
                    </Stack>
                    )
                  })}
                </Stack>

                <Divider sx={{ my: 2 }} />
                <Stack spacing={1}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Subtotal</Typography>
                    <Typography>{formatMoney(folio.subtotal)}</Typography>
                  </Stack>
                  {folio.discount_total > 0 && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Descuento</Typography>
                      <Typography>−{formatMoney(folio.discount_total)}</Typography>
                    </Stack>
                  )}
                  <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Typography variant="h6">Total</Typography>
                    <MoneyText cents={folio.total} variant="h4" srLabel="Total" />
                  </Stack>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">
                      {isBooking ? 'Anticipo' : 'Pagado'}
                    </Typography>
                    <Typography className="numeric">{formatMoney(folio.amount_paid)}</Typography>
                  </Stack>
                  {isBooking && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Saldo pendiente</Typography>
                      {/* Owed by the customer — neutral ink, not teal. */}
                      <Typography className="numeric">
                        {formatMoney(folio.pending_balance ?? folio.total - folio.amount_paid)}
                      </Typography>
                    </Stack>
                  )}
                  {/* US-AG59 (folio-surface-parity D6) — the cancellation's money outcome and
                      the customer's credit, in the component the SELLER's detail renders too.
                      These rows lived here as inline JSX while the seller's screen showed nothing
                      (BUG-034); a second copy would have repeated the drift, so there is one. */}
                  <FolioMoneyOutcome folio={folio} formatDate={formatDate} />
                </Stack>
              </Box>
            </SectionCard>

            {/* US-A93 (D8) — the access tickets, on BOTH surfaces. «Mi QR no funciona» is a call
                that reaches the admin, and until now they could not see what the customer was
                holding; the payload has carried the lines all along. Collapsed for them, open for
                the seller, who is the one showing it across a counter. */}
            {folio.status === 'paid' && (
              <Box>
                <Stack
                  direction="row"
                  sx={{ alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <Typography variant="h6">Boletos de acceso</Typography>
                  <Button
                    size="small"
                    onClick={() => setQrOpen((v) => !v)}
                    aria-expanded={qrOpen}
                    endIcon={qrOpen ? <ExpandLessRounded /> : <ExpandMoreRounded />}
                  >
                    {qrOpen ? 'Ocultar' : 'Ver'}
                  </Button>
                </Stack>
                <Collapse in={qrOpen} unmountOnExit>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Un QR por servicio. El cliente lo presenta a la entrada; un agente lo escanea
                    para canjear un pase.
                  </Typography>
                  <Stack spacing={2}>
                    {folio.lines.map((line) => (
                      <TicketQr key={line.id} line={line} />
                    ))}
                  </Stack>
                </Collapse>
              </Box>
            )}

            {cancel.isError && (
              <Alert severity="error">No se pudo cancelar esta venta. Inténtalo de nuevo.</Alert>
            )}

            {/* One action block, not floating verbs (design review, Should Fix 2): the booking
                actions and the US-A21 cancel share a tight stack — secondary above destructive.
                The whole block parks while a petition is open (resolving it IS the action), the
                cancel additionally parks on unverified money (BUG-030 — `Rechazar pago` is that
                cancel) and on a fully departed folio (a countable fact, not a cancellable sale). */}
            {!hasOpenPetition && (
              <Stack spacing={1.5}>
                {/* US-AG07/07.4 — a live apartado settles, reschedules or cancels here (priced by
                    the ladder since US-A76 — it is no longer a non-refundable flow). */}
                <BookingActions folio={folio} quote={quote} quoteLoading={isLoading} />

                {isAdmin && !isCancelled && !isBooking && !awaitingVerification && !allDeparted && (
                  <Button
                    variant="outlined"
                    color="error"
                    size="large"
                    onClick={() => setConfirmOpen(true)}
                  >
                    Cancelar venta
                  </Button>
                )}
              </Stack>
            )}

          </Stack>
        )}

        {/* Every overlay below is an ADMIN authorization — cancelling the sale, cancelling one
            activity, confirming that cash left the drawer against the customer's PIN. The seller's
            surface renders none of them, and none of their triggers either (D7/D13). */}
        {isAdmin && (
          <>
        {/* The US-A21 cancel confirmation on the canonical overlay (ConfirmSheet), like every
            other confirmation in the app — not a centered Dialog. */}
        <ConfirmSheet
          open={confirmOpen}
          onClose={closeDialog}
          title="¿Cancelar esta venta?"
          description="Esto libera todos los lugares de cada servicio en la venta y no se puede deshacer. Los boletos de acceso del cliente dejarán de ser válidos."
          detail={
            <>
              {/* US-A69 — the money, before committing. Computed server-side by the same function
                  the cancel endpoint uses, so what is shown here is what gets written.

                  D10 — there are no switches in this dialog any more. The clawback choice (US-A26)
                  and the company-cancellation override (US-A71) are both withdrawn: a cancellation
                  is priced by the company's ladder and by nothing the person cancelling decides. An
                  admin who wants a different outcome changes the policy, where the terms are visible
                  and apply to everyone — not this one folio, silently. */}
              {quote && <RefundQuote quote={quote} folio={folio} />}

              <TextField
                label="Motivo (opcional)"
                size="small"
                fullWidth
                multiline
                minRows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                sx={{ mt: quote ? 2 : 0 }}
              />
            </>
          }
          confirmLabel="Cancelar venta"
          onConfirm={handleCancel}
          busy={cancel.isPending}
          cancelLabel="Conservar venta"
        />

        {/* US-A22 — the LINE cancel confirmation, same canonical overlay. The money it states is
            the SUBSET quote (line_refund), computed server-side by the same arithmetic the
            endpoint writes — the sheet confirms a number it did not compute. */}
        <ConfirmSheet
          open={!!lineTarget}
          onClose={closeLineDialog}
          title={`¿Cancelar ${lineTarget?.service_name ?? 'esta actividad'}?`}
          description="Esto libera los lugares de esta actividad y no se puede deshacer. El resto de la venta sigue activo y sus boletos siguen siendo válidos."
          detail={
            <>
              {lineQuote && lineQuote.line_refund != null && (
                <Stack spacing={0.5} sx={{ mb: 1 }}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">Se devuelve al cliente</Typography>
                    <Typography className="numeric" sx={{ fontWeight: 600 }}>
                      {formatMoney(lineQuote.line_refund)}
                    </Typography>
                  </Stack>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">La empresa retiene</Typography>
                    <Typography className="numeric">
                      {formatMoney(
                        Math.max(0, (lineTarget?.allocated ?? 0) - lineQuote.line_refund),
                      )}
                    </Typography>
                  </Stack>
                  {lineQuote.redeemed && (
                    <Typography variant="caption" color="text.secondary">
                      Esta actividad ya fue usada — retiene su total sin importar la política.
                    </Typography>
                  )}
                </Stack>
              )}
              <TextField
                label="Motivo (opcional)"
                size="small"
                fullWidth
                multiline
                minRows={2}
                value={lineReason}
                onChange={(e) => setLineReason(e.target.value)}
              />
            </>
          }
          confirmLabel="Cancelar actividad"
          onConfirm={handleCancelLine}
          busy={cancelLine.isPending}
          cancelLabel="Conservar actividad"
        />

        {/* US-A23 / US-T05 — confirm the physical cash refund, on the canonical form host
            (FormSheet). The PIN proves the client was present to receive it; the override is for
            lost-link cases and requires a note for the audit trail. The PIN/note validation gates
            the fixed footer submit; dismissal is the sheet contract (puller / X / backdrop). */}
        <FormSheet
          open={refundOpen}
          onClose={() => setRefundOpen(false)}
          title="Confirmar reembolso"
          submitLabel="Confirmar reembolso"
          onSubmit={handleRefundSubmit}
          busy={refund.isPending}
          disabled={useOverride ? !overrideNote.trim() : !pin.trim()}
          error={
            refund.isError ? <Alert severity="error">{refundErrorMessage}</Alert> : undefined
          }
        >
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Captura el PIN que el cliente ve en su portal — es su comprobante de que recibió
              el efectivo. Esto no mueve ningún monto: solo registra que el reembolso se entregó.
            </Typography>
            {!useOverride ? (
              <TextField
                label="PIN del cliente"
                fullWidth
                autoFocus
                slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 6 } }}
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            ) : (
              <TextField
                label="Nota de respaldo"
                fullWidth
                multiline
                minRows={2}
                autoFocus
                required
                helperText="Explica por qué se confirma sin PIN (ej. el cliente perdió su enlace)."
                value={overrideNote}
                onChange={(e) => setOverrideNote(e.target.value)}
              />
            )}
            <FormControlLabel
              sx={{ mx: 0 }}
              control={
                <Switch checked={useOverride} onChange={(e) => setUseOverride(e.target.checked)} />
              }
              label={
                <Typography variant="body2">Registrar sin PIN (con nota)</Typography>
              }
            />
          </Stack>
        </FormSheet>
          </>
        )}
      </Box>
    </Fade>
  )
}

// US-A69 — the refund the policy computes, shown BEFORE the admin commits. The server calculates
// it with the same function the cancel endpoint uses, so this is a preview of a decision already
// made rather than a client-side re-implementation that could drift from it.
//
// The per-line breakdown only appears when it explains something: on a single-line folio the
// headline number already says everything, and repeating it adds noise to a confirmation dialog.
function RefundQuote({ quote, folio }: { quote: CancellationQuote; folio?: FolioDetail }) {
  // Straight from the server — nothing in this dialog can change it any more (D10), so there is no
  // client-side re-derivation that could drift from what gets written.
  const { refund, retention, kept_commission: keptCommission } = quote
  const reversedCommission = quote.reversed_commission

  const lineName = (lineId: string) =>
    folio?.lines.find((l) => l.id === lineId)?.service_name ?? 'Servicio'

  return (
    <Box sx={{ border: 1, borderColor: 'grey.200', borderRadius: 2, p: 2, bgcolor: 'grey.50' }}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Typography variant="body2" color="text.secondary">
          Se devuelve al cliente
        </Typography>
        <MoneyText cents={refund} variant="h6" srLabel="Se devuelve al cliente" />
      </Stack>

      {retention > 0 && (
        <Stack
          direction="row"
          sx={{ justifyContent: 'space-between', alignItems: 'baseline', mt: 0.5 }}
        >
          <Typography variant="caption" color="text.secondary">
            La empresa retiene
          </Typography>
          <Typography variant="caption" color="text.secondary" className="numeric">
            {formatMoney(retention)}
          </Typography>
        </Stack>
      )}

      {(keptCommission > 0 || reversedCommission > 0) && (
        <Stack
          direction="row"
          sx={{ justifyContent: 'space-between', alignItems: 'baseline', mt: 0.5 }}
        >
          <Typography variant="caption" color="text.secondary">
            {reversedCommission > 0 ? 'El agente pierde de comisión' : 'El agente conserva su comisión'}
          </Typography>
          <Typography variant="caption" color="text.secondary" className="numeric">
            {formatMoney(reversedCommission > 0 ? reversedCommission : keptCommission)}
          </Typography>
        </Stack>
      )}

      {quote.lines.length > 1 && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Stack spacing={0.5}>
            {quote.lines.map((l) => (
              <Stack
                key={l.line_id}
                direction="row"
                sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 2 }}
              >
                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0 }} noWrap>
                  {lineName(l.line_id)}
                  {l.redeemed
                    ? ' · ya utilizado'
                    : l.hours_out !== null && l.hours_out >= 0
                      ? ` · faltan ${l.hours_out} h`
                      : ' · ya salió'}
                </Typography>
                <Typography variant="caption" color="text.secondary" className="numeric">
                  {l.refund_pct}%
                </Typography>
              </Stack>
            ))}
          </Stack>
        </>
      )}
    </Box>
  )
}
