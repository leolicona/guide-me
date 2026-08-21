import { useState } from 'react'
import { Alert, Button, Stack, TextField, Typography } from '@mui/material'
import { CheckCircleRounded } from '@mui/icons-material'
import { ConfirmSheet, FormSheet, SectionCard } from '../../../components'
import {
  useVerifyPayment,
  useRejectPayment,
  TicketWhatsAppButton,
  DeliveryBadge,
} from '../../bookings'
import {
  useApproveCancellationRequest,
  useRejectCancellationRequest,
} from '../hooks'
import { useOrgDateFormatter } from '../../organization'
import { formatMoney } from '../../catalog/types'
import type { FolioDetail } from '../types'

// US-A84 (D14/D21) — the work a folio needs, on the folio itself: THE pending-action card.
//
// This component owns the detail's whole D12 ladder — solicitud → verificación → reembolso →
// entrega — and renders exactly ONE rung (or nothing). The exclusion used to be three booleans
// threaded through three blocks of the page; a future slip could render two rungs at once. Here
// the ladder is structural: one component, one branch, one card in one fixed position, so the eye
// learns "the card under the chips is what this folio needs from me".
//
// The two DESTRUCTIVE actions landed here first (from the deleted `PaymentVerificationTab` /
// `CancellationRequestsTab` tabs), because rejecting a payment cancels a sale and claws back the
// seller's commission, and rejecting a request writes a note the customer reads. Q6 of
// `pending-work-queues.spec.md` already ruled this for the refund confirm — a money action one tap
// from a list is how the wrong folio gets confirmed — and the reasoning does not stop at refunds.
//
// Every overlay here is a `ConfirmSheet` / `FormSheet`. The tabs used MUI `Dialog`s, which the
// design system forbids for confirmations and entity edits (`CLAUDE.md`); moving them is the
// occasion to stop carrying that exception.

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

export function FolioWorkActions({
  folio,
  onConfirmRefund,
}: {
  folio: FolioDetail
  /** Opens the page's refund FormSheet (PIN / override) — the sheet stays with the page because
   *  its success path opens the receipt composer, which is page-level navigation. */
  onConfirmRefund: () => void
}) {
  const formatDate = useOrgDateFormatter(DATE_FMT)
  const verify = useVerifyPayment()
  const rejectPayment = useRejectPayment()
  const approveRequest = useApproveCancellationRequest()
  const rejectRequest = useRejectCancellationRequest()

  const [confirming, setConfirming] = useState<'verify' | 'approve' | null>(null)
  const [rejectingPayment, setRejectingPayment] = useState(false)
  const [rejectingRequest, setRejectingRequest] = useState(false)
  const [paymentReason, setPaymentReason] = useState('')
  const [requestNote, setRequestNote] = useState('')

  const requests = folio.folio_requests ?? []
  const pending = requests.find((r) => r.status === 'pending')
  // US-AG52 — the review surface must know WHAT it is approving. The backend already branched on
  // `kind`; a sheet that says "Aprobar y cancelar folio" over a petition that MOVES a date is a
  // button that lies about the destructive half. Absent on pre-rename rows → cancellation.
  const pendingIsReschedule = pending?.kind === 'reschedule'
  // The line the tourist asked to move, for the "from → to" the seller decides on.
  const pendingLine = pendingIsReschedule
    ? folio.lines?.find((l) => l.id === pending?.folio_line_id)
    : undefined
  const awaitingVerification =
    folio.payment_verification === 'pending' && folio.status !== 'cancelled'
  // Rung 3 — the open refund obligation (US-A23/US-T05). A warning that carries a BUTTON is work,
  // not a notice, so it ranks as a rung: an orphaned petition on a cancelled folio gets resolved
  // before cash leaves the drawer.
  const refundPending = folio.refund_status === 'pending'
  // Rung 4 — ticket delivery (whatsapp-qr-delivery, D15). Also the card's resting face: it stays
  // for RE-sending after delivery (the DeliveryBadge says which), because re-send is a tool that
  // needs a home even when nothing is pending.
  const deliverable = folio.status === 'paid' && !!folio.portal_link

  // The ladder, structural: the first true rung is the ONLY one that renders. Resolved petitions
  // no longer render here — the timeline carries them (approved ones as their events, rejected
  // ones as derived rows) — so a folio with only history renders nothing.
  const rung = pending
    ? 'petition'
    : awaitingVerification
      ? 'verification'
      : refundPending
        ? 'refund'
        : deliverable
          ? 'delivery'
          : null
  if (!rung) return null

  return (
    <>
      {/* The live request outranks everything else on this folio: approving it cancels the sale,
          which makes any payment verification below moot (D12, one layer down from the card). */}
      {rung === 'petition' && pending && (
        <SectionCard>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
            {pendingIsReschedule ? 'El cliente pidió reagendar' : 'El cliente pidió cancelar'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatDate(pending.created_at)}
            {pending.reason ? ` — ${pending.reason}` : ''}
          </Typography>
          {pendingIsReschedule && (
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {pendingLine
                ? `${pendingLine.service_name} · ${pendingLine.slot_date} ${pendingLine.slot_start_time}`
                : 'Servicio'}
              {' → '}
              <strong>
                {pending.to_slot_date} {pending.to_slot_start_time}
              </strong>
            </Typography>
          )}
          <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap', gap: 1 }}>
            {/* A reschedule approval is NOT destructive — nothing ends, no ladder runs — so it
                takes the primary accent; the cancellation keeps error red. */}
            <Button
              variant="contained"
              disableElevation
              color={pendingIsReschedule ? 'primary' : 'error'}
              onClick={() => setConfirming('approve')}
            >
              {pendingIsReschedule ? 'Aprobar reagenda' : 'Aprobar cancelación'}
            </Button>
            <Button
              color="inherit"
              onClick={() => {
                setRequestNote('')
                setRejectingRequest(true)
              }}
            >
              Rechazar solicitud
            </Button>
          </Stack>
        </SectionCard>
      )}

      {/* An open petition parks the verification — one pending action at a time, the header chip
          still says the unverified money exists. */}
      {rung === 'verification' && (
        <SectionCard>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
            Pago por verificar
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Transferencia
            {folio.payment_reference ? ` · Ref. ${folio.payment_reference}` : ''}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap', gap: 1 }}>
            <Button
              variant="contained"
              disableElevation
              startIcon={<CheckCircleRounded />}
              onClick={() => setConfirming('verify')}
            >
              Verificar
            </Button>
            <Button
              color="error"
              onClick={() => {
                setPaymentReason('')
                setRejectingPayment(true)
              }}
            >
              Rechazar pago
            </Button>
          </Stack>
        </SectionCard>
      )}

      {/* Rung 3 keeps its WARNING anatomy inside the unified card slot — a cash obligation must
          not read like a neutral title. The container changed; the semantics did not. */}
      {rung === 'refund' && (
        <Alert severity="warning">
          <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
            <span>
              Reembolso pendiente de {formatMoney(folio.refund_amount ?? folio.amount_paid)} —
              pide al cliente el PIN de su portal al entregarle el efectivo.
            </span>
            {/* The action that hands cash across the counter reads as a BUTTON, not as floating
                text (design review, Must Fix 5). Contained teal: the one accent always marks the
                next action. Full-width on the phone, natural on desktop. */}
            <Button
              variant="contained"
              disableElevation
              onClick={onConfirmRefund}
              sx={{ whiteSpace: 'nowrap', alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
            >
              Confirmar reembolso
            </Button>
          </Stack>
        </Alert>
      )}

      {/* Rung 4 — whatsapp-qr-delivery, admin oversight: (re-)send the tickets over WhatsApp on
          the seller's behalf. Structurally last: a petition, unverified money or an open refund
          parks it — delivering tickets for a sale the customer asked to cancel (or whose money is
          unconfirmed) is exactly what blocking-first exists to prevent. */}
      {rung === 'delivery' && (
        <SectionCard>
          <Stack spacing={1.5}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
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
            {/* The "Pendiente de enviar" chip above already states this fact — a second amber
                line saying it again is noise (design review, Should Fix 1). */}
          </Stack>
        </SectionCard>
      )}

      {/* US-A84 rule 7's history moved into the timeline (`FolioTimeline`): approved petitions
          already appear there as their `cancelled`/`rescheduled` events, and REJECTED ones
          interleave as derived rows — one Historial, not two. */}

      <ConfirmSheet
        open={confirming === 'verify'}
        onClose={() => setConfirming(null)}
        title="¿Verificar el pago?"
        description="Se liberan los boletos y el correo con el QR sale automáticamente."
        confirmLabel="Verificar"
        confirmColor="primary"
        busy={verify.isPending}
        onConfirm={() => verify.mutate(folio.id, { onSuccess: () => setConfirming(null) })}
      />

      <ConfirmSheet
        open={confirming === 'approve'}
        onClose={() => setConfirming(null)}
        title={pendingIsReschedule ? '¿Aprobar la reagenda?' : '¿Aprobar la cancelación?'}
        description={
          pendingIsReschedule
            ? 'Se mueve el servicio al horario que pidió el cliente y se libera el anterior. Si el folio está pagado, el boleto anterior deja de funcionar y se envía uno nuevo. Si ya no hay lugar, la solicitud se rechaza sola con el motivo y fechas alternativas.'
            : 'Esto cancela el folio completo: libera todos los lugares, notifica al cliente por correo y — si el folio tiene pago registrado — genera un PIN de reembolso que el cliente verá en su portal. El reembolso y la comisión del vendedor los decide la política de cancelación de la empresa.'
        }
        confirmLabel={
          approveRequest.isPending
            ? 'Aprobando…'
            : pendingIsReschedule
              ? 'Aprobar reagenda'
              : 'Aprobar y cancelar folio'
        }
        confirmColor={pendingIsReschedule ? 'primary' : undefined}
        busy={approveRequest.isPending}
        error={
          approveRequest.isError ? (
            <Alert severity="error">No se pudo aprobar la solicitud. Inténtalo de nuevo.</Alert>
          ) : null
        }
        onConfirm={() =>
          // Approving is an authorisation with nothing to configure — a reschedule's guards and
          // destination live on the petition, and a cancellation's money (refund + commission
          // clawback) is priced by the org's ladder (D10), never chosen here.
          pending &&
          approveRequest.mutate(pending.id, { onSuccess: () => setConfirming(null) })
        }
      />

      {/* A required note, so a form host rather than a confirm: the customer reads this text in
          their portal, and an empty rejection is a decision with no explanation attached. */}
      <FormSheet
        open={rejectingRequest}
        onClose={() => setRejectingRequest(false)}
        title="Rechazar solicitud"
        submitLabel={rejectRequest.isPending ? 'Rechazando…' : 'Rechazar solicitud'}
        busy={rejectRequest.isPending}
        disabled={!requestNote.trim()}
        error={
          rejectRequest.isError ? (
            <Alert severity="error">No se pudo rechazar la solicitud. Inténtalo de nuevo.</Alert>
          ) : null
        }
        onSubmit={(e) => {
          e.preventDefault()
          if (!pending || !requestNote.trim()) return
          rejectRequest.mutate(
            { id: pending.id, input: { note: requestNote.trim() } },
            { onSuccess: () => setRejectingRequest(false) },
          )
        }}
      >
        <Stack spacing={2} sx={{ px: 2, pb: 2 }}>
          <Typography variant="body2" color="text.secondary">
            La reserva sigue activa y nada cambia en el folio. Explica el motivo — el cliente lo
            verá en su portal.
          </Typography>
          <TextField
            label="Motivo del rechazo"
            fullWidth
            multiline
            minRows={2}
            required
            value={requestNote}
            onChange={(e) => setRequestNote(e.target.value)}
          />
        </Stack>
      </FormSheet>

      <FormSheet
        open={rejectingPayment}
        onClose={() => setRejectingPayment(false)}
        title="Rechazar pago"
        submitLabel={rejectPayment.isPending ? 'Rechazando…' : 'Rechazar venta'}
        busy={rejectPayment.isPending}
        error={
          rejectPayment.isError ? (
            <Alert severity="error">No se pudo rechazar el pago. Inténtalo de nuevo.</Alert>
          ) : null
        }
        onSubmit={(e) => {
          e.preventDefault()
          rejectPayment.mutate(
            { id: folio.id, reason: paymentReason.trim() || undefined },
            { onSuccess: () => setRejectingPayment(false) },
          )
        }}
      >
        <Stack spacing={2} sx={{ px: 2, pb: 2 }}>
          <Typography variant="body2" color="text.secondary">
            La venta se cancelará: se liberan los lugares y se descuenta la comisión del vendedor.
          </Typography>
          <TextField
            label="Motivo (opcional)"
            placeholder="Ej. No se recibió la transferencia"
            fullWidth
            multiline
            minRows={2}
            value={paymentReason}
            onChange={(e) => setPaymentReason(e.target.value)}
          />
        </Stack>
      </FormSheet>
    </>
  )
}
