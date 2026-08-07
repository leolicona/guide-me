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
  folioTimeChip,
  useNowSeconds,
} from '../features/folios'
import { refundReceiptUrl } from '../features/folios/refundReceipt'
import { FolioWorkActions } from '../features/folios/components/FolioWorkActions'
import type { FolioDetail } from '../features/folios/types'
import { useOrgDateFormatter } from '../features/organization'
import type { CancellationQuote } from '../features/organization/types'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import {
  BookingActions,
  ExpiredBookingBanner,
  TicketWhatsAppButton,
  DeliveryBadge,
} from '../features/bookings'
import { deliveryState } from '../features/pos/delivery'
import { ServiceError } from '../services/authService'
import { formatMoney } from '../features/catalog/types'
import { folioLineMeta } from '../features/folios/folioLineLabel'
import { ConfirmSheet, FormSheet, MoneyText, SectionCard, StatusChip } from '../components'
import { ROUTES } from '../config/routes'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// US-A85 — what a line says about whether it was used. Functional color only, and only when there
// is something to say: a line still ahead of its departure says nothing, because "not used yet" is
// not a fact about the sale. Never teal (it carries no state meaning).
const lineFulfillmentNote = (line: { fulfillment?: string; quantity: number; redeemed_count?: number }) => {
  if (line.fulfillment === 'no_show') return { text: 'Nadie usó estos lugares', color: 'error.main' }
  if (line.fulfillment === 'partial') {
    return {
      text: `Usaron ${line.redeemed_count ?? 0} de ${line.quantity}`,
      color: 'warning.main',
    }
  }
  if (line.fulfillment === 'fulfilled') return { text: 'Usado', color: 'success.main' }
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
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h5" component="h1" noWrap>
                  {folio.customer_name ?? 'Sin nombre'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatDate(folio.created_at)} · {folio.agent.name}
                  {/* US-A68 — the affiliate shift operator who took the sale, when applicable. */}
                  {folio.operator_name ? ` · ${folio.operator_name}` : ''}
                </Typography>
                {/* US-AG07.3 — the folio's clock, drawn exactly as the list card draws its time
                    chip: the apartado countdown, or once cancelled with money owed, the age of
                    the debt. Derives from useNowSeconds (D19), never Date.now() in render. */}
                {timeChip && (
                  <Chip
                    size="small"
                    variant="outlined"
                    color={timeChip.tone}
                    label={timeChip.label}
                    sx={{ mt: 0.5, display: 'flex', width: 'fit-content' }}
                  />
                )}
              </Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                {/* One StatusChip per active axis, in the list's vocabulary (D8): an axis at its
                    default value says nothing here. Icon-paired functional colors, never teal. */}
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
                <FolioStatusChip status={folio.status} />
              </Stack>
            </Stack>

            {/* An expired apartado (cancelled + booking_expires_at) gets the reactivation
                banner; a plain admin cancellation keeps the audit notice. */}
            {isCancelled && folio.booking_expires_at == null && (
              <Alert severity="error">
                Cancelado{folio.cancelled_at ? ` el ${formatDate(folio.cancelled_at)}` : ''}
                {folio.cancellation_reason ? ` — ${folio.cancellation_reason}` : ''}
                {folio.cancellation_clawback
                  ? ' · comisión del agente recuperada'
                  : ' · comisión absorbida por la empresa'}
              </Alert>
            )}
            <ExpiredBookingBanner folio={folio} />

            {/* US-A84 (D14) — the work this folio needs, and the cancellation-request history that
                the absorbed Solicitudes tab used to hold. Renders nothing when there is neither. */}
            <FolioWorkActions folio={folio} />

            {/* US-A23 / US-T05 — the open refund obligation: the client reads their PIN in
                the portal and hands it over to receive the cash; confirming here closes
                the loop. */}
            {folio.refund_status === 'pending' && (
              <Alert
                severity="warning"
                action={
                  <Button color="inherit" size="small" onClick={openRefundDialog}>
                    Confirmar reembolso
                  </Button>
                }
              >
                Reembolso pendiente de {formatMoney(folio.refund_amount ?? folio.amount_paid)} —
                pide al cliente el PIN de su portal al entregarle el efectivo.
              </Alert>
            )}
            {folio.refund_status === 'refunded' && (
              <Alert severity="success" icon={false}>
                Reembolso confirmado
                {folio.refunded_at ? ` el ${formatDate(folio.refunded_at)}` : ''}
                {folio.refund_note ? ` — sin PIN: ${folio.refund_note}` : ' — con PIN del cliente'}
              </Alert>
            )}

            <Card>
              <CardContent>
                {(folio.customer_email || folio.customer_phone) && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    {folio.customer_email}
                    {folio.customer_email && folio.customer_phone ? ' · ' : ''}
                    {folio.customer_phone}
                  </Typography>
                )}

                <Stack spacing={2} divider={<Divider flexItem />}>
                  {folio.lines.map((line) => (
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
                        {/* US-A85 (D2) — fulfilment lives on the LINE, and the detail is the only
                            place the breakdown can be read: "the Tuesday tour was used, nobody came
                            to Thursday's". The card shows only the worst of them. */}
                        {lineFulfillmentNote(line) && (
                          <Typography
                            variant="caption"
                            sx={{ display: 'block', color: lineFulfillmentNote(line)!.color, fontWeight: 600 }}
                          >
                            {lineFulfillmentNote(line)!.text}
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
                  ))}
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

            {/* whatsapp-qr-delivery — admin oversight: re-send the tickets over WhatsApp on the
                seller's behalf (D15). Uses the seller's name in the message. */}
            {folio.status === 'paid' && folio.portal_link && (
              <SectionCard>
                <Stack spacing={1.5}>
                  <Stack
                    direction="row"
                    sx={{ alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      Entregar boletos
                    </Typography>
                    <DeliveryBadge folio={folio} />
                  </Stack>
                  <TicketWhatsAppButton
                    folio={folio}
                    surface="admin"
                    variant="primary"
                    agentName={folio.agent.name}
                  />
                  {deliveryState(folio) === 'pending' && (
                    <Stack
                      direction="row"
                      spacing={0.5}
                      sx={{ alignItems: 'center', color: 'warning.main' }}
                    >
                      <WarningAmberRounded fontSize="small" />
                      <Typography variant="caption">Aún no enviado al cliente</Typography>
                    </Stack>
                  )}
                </Stack>
              </SectionCard>
            )}

            {/* US-AG07/07.4/07.5 — a live apartado settles or cancels here (priced by the ladder
                since US-A76 — it is no longer a non-refundable flow), or once expired, reactivates.
                The US-A21 cancel below is hidden for bookings so the two never overlap. */}
            <BookingActions folio={folio} quote={quote} quoteLoading={isLoading} />

            {!isCancelled && !isBooking && (
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
