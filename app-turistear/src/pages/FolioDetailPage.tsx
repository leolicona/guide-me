import { useState } from 'react'
import type { FormEvent } from 'react'
import { useParams, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Alert,
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
import {
  useFolio,
  useCancelFolio,
  useConfirmRefund,
  FolioStatusChip,
  FolioTimeline,
  folioTimeChip,
  useNowSeconds,
} from '../features/folios'
import { refundReceiptUrl } from '../features/folios/refundReceipt'
import { FolioWorkActions } from '../features/folios/components/FolioWorkActions'
import type { FolioDetail } from '../features/folios/types'
import { useOrgDateFormatter } from '../features/organization'
import type { CancellationQuote } from '../features/organization/types'
import BlockRounded from '@mui/icons-material/BlockRounded'
import RemoveDoneRounded from '@mui/icons-material/RemoveDoneRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import PhoneRounded from '@mui/icons-material/PhoneRounded'
import MailOutlineRounded from '@mui/icons-material/MailOutlineRounded'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import { isSendablePhone, normalizePhone } from '../features/pos/phone'
import { BookingActions } from '../features/bookings'
import { ServiceError } from '../services/authService'
import { formatMoney } from '../features/catalog/types'
import { folioLineMeta } from '../features/folios/folioLineLabel'
import { ConfirmSheet, FormSheet, MoneyText, StatusChip } from '../components'
import { ROUTES } from '../config/routes'

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

export default function FolioDetailPage() {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, isError } = useFolio(id)
  const folio = data?.folio
  // US-A84 D19 — the clock resolves in an effect, never `Date.now()` in render: this page sits
  // open while an admin works, and a countdown frozen at load time is a wrong screen.
  const nowSeconds = useNowSeconds()
  // US-A69 — what cancelling right now would cost, priced by the org's ladder. Every org has one
  // (D17), so this is null only for a folio that is already cancelled: nothing left to quote.
  const quote = data?.quote ?? null
  const cancel = useCancelFolio()
  const refund = useConfirmRefund()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reason, setReason] = useState('')
  // US-A23 / US-T05 — refund confirmation dialog: PIN (primary) or no-PIN override + note.
  const [refundOpen, setRefundOpen] = useState(false)
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
        <Button component={RouterLink} to={ROUTES.FOLIOS} startIcon={<ArrowBackRounded />} sx={{ mb: 2 }}>
          Folios
        </Button>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && <Alert severity="error">No se pudo cargar este folio. Inténtalo de nuevo.</Alert>}

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
            <FolioWorkActions folio={folio} onConfirmRefund={openRefundDialog} />

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

            <Card>
              <CardContent>
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
                        <Typography variant="subtitle2">{line.service_name}</Typography>
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
                  {/* The cancellation's money OUTCOME, recorded where money lives — the same
                      "Se devuelve / La empresa retiene" pair the RefundQuote previewed before
                      the admin committed: the quote was the decision's preview, this is its
                      record. Without it a cancelled folio read as if the sale were still whole
                      (`Pagado $3,000` and silence). `refund_status: 'none'` with money paid is
                      the 0%-ladder case — full retention, said out loud, because that is
                      exactly where silence confuses most. Delivery state is icon-paired on the
                      row (never color-alone); the WHEN and HOW stay the Historial's. */}
                  {isCancelled && folio.amount_paid > 0 && (
                    <>
                      {(folio.refund_amount ?? 0) > 0 && (
                        <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                          <Box>
                            <Typography color="text.secondary">Se devuelve al cliente</Typography>
                            {folio.refund_status === 'refunded' ? (
                              <Typography
                                variant="caption"
                                sx={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 0.5,
                                  color: 'success.main',
                                  fontWeight: 600,
                                }}
                              >
                                <CheckCircleRounded sx={{ fontSize: 14 }} />
                                Entregado
                              </Typography>
                            ) : (
                              <Typography
                                variant="caption"
                                sx={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 0.5,
                                  color: 'warning.main',
                                  fontWeight: 600,
                                }}
                              >
                                <ScheduleRounded sx={{ fontSize: 14 }} />
                                Por entregar
                              </Typography>
                            )}
                          </Box>
                          <Typography className="numeric">
                            {formatMoney(folio.refund_amount ?? 0)}
                          </Typography>
                        </Stack>
                      )}
                      {folio.amount_paid - (folio.refund_amount ?? 0) > 0 && (
                        <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                          <Typography color="text.secondary">La empresa retiene</Typography>
                          <Typography className="numeric">
                            {formatMoney(folio.amount_paid - (folio.refund_amount ?? 0))}
                          </Typography>
                        </Stack>
                      )}
                    </>
                  )}
                  {/* US-A87 (D6/D10) — what the close left the customer, and until when. This is
                      the number the agent honours by MANUAL DISCOUNT while the checkout cannot
                      spend it — an agent who cannot see the credit cannot decide to apply it.
                      Positive green: it is the customer's money, not the company's. */}
                  {(folio.credit_amount ?? 0) > 0 && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <Box>
                        <Typography color="text.secondary">Saldo a favor del cliente</Typography>
                        {folio.credit_expires_at && (
                          <Typography variant="caption" color="text.secondary">
                            Vigente hasta el {formatDate(folio.credit_expires_at)}
                          </Typography>
                        )}
                        {/* The retired ExpiredBookingBanner's one non-redundant sentence, anchored
                            to the money it was about: if the customer returns, it is a NEW sale,
                            and this credit is honoured by manual discount (US-A87 D6/D10). */}
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          Se aplica como descuento manual en una venta nueva
                        </Typography>
                      </Box>
                      <MoneyText
                        cents={folio.credit_amount!}
                        variant="h6"
                        semantic="positive"
                        srLabel="Saldo a favor del cliente"
                      />
                    </Stack>
                  )}
                </Stack>
              </CardContent>
            </Card>

            {cancel.isError && (
              <Alert severity="error">No se pudo cancelar este folio. Inténtalo de nuevo.</Alert>
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

                {!isCancelled && !isBooking && !awaitingVerification && !allDeparted && (
                  <Button
                    variant="outlined"
                    color="error"
                    size="large"
                    onClick={() => setConfirmOpen(true)}
                  >
                    Cancelar folio
                  </Button>
                )}
              </Stack>
            )}

          </Stack>
        )}

        {/* The US-A21 cancel confirmation on the canonical overlay (ConfirmSheet), like every
            other confirmation in the app — not a centered Dialog. */}
        <ConfirmSheet
          open={confirmOpen}
          onClose={closeDialog}
          title="¿Cancelar este folio?"
          description="Esto libera todos los lugares de cada servicio en el folio y no se puede deshacer. Los boletos de acceso del cliente dejarán de ser válidos."
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
          confirmLabel="Cancelar folio"
          onConfirm={handleCancel}
          busy={cancel.isPending}
          cancelLabel="Conservar folio"
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
