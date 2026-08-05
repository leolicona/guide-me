import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import { ConfirmSheet, FormSheet, SectionCard } from '../../../components'
import { useVerifyPayment, useRejectPayment } from '../../bookings'
import {
  useApproveCancellationRequest,
  useRejectCancellationRequest,
} from '../hooks'
import { useOrgDateFormatter } from '../../organization'
import type { FolioDetail } from '../types'

// US-A84 (D14) — the work a folio needs, on the folio itself.
//
// These four actions used to live in `PaymentVerificationTab` and `CancellationRequestsTab`, which
// this feature deletes. Two of them stay one tap from the list (`Verificar y enviar` is the card's
// verb); the two DESTRUCTIVE ones land here, because rejecting a payment cancels a sale and claws
// back the seller's commission, and rejecting a request writes a note the customer reads. Q6 of
// `pending-work-queues.spec.md` already ruled this for the refund confirm — a money action one tap
// from a list is how the wrong folio gets confirmed — and the reasoning does not stop at refunds.
//
// Every overlay here is a `ConfirmSheet` / `FormSheet`. The tabs used MUI `Dialog`s, which the
// design system forbids for confirmations and entity edits (`CLAUDE.md`); moving them is the
// occasion to stop carrying that exception.

const REQUEST_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  approved: 'Aprobada',
  rejected: 'Rechazada',
}

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

export function FolioWorkActions({ folio }: { folio: FolioDetail }) {
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
  const [clawback, setClawback] = useState(false)

  const requests = folio.folio_requests ?? []
  const pending = requests.find((r) => r.status === 'pending')
  // The live request is already presented above, in full, as WORK. Repeating it in the history
  // below put the same request on screen twice, with the same reason under each — a defect no test
  // could have found, and one that only showed up when the component was actually rendered.
  const resolved = requests.filter((r) => r.status !== 'pending')
  const awaitingVerification =
    folio.payment_verification === 'pending' && folio.status !== 'cancelled'

  if (!pending && !awaitingVerification && resolved.length === 0) return null

  return (
    <>
      {/* The live request outranks everything else on this folio: approving it cancels the sale,
          which makes any payment verification below moot (D12, one layer down from the card). */}
      {pending && (
        <SectionCard>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
            El cliente pidió cancelar
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatDate(pending.created_at)}
            {pending.reason ? ` — ${pending.reason}` : ''}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap', gap: 1 }}>
            <Button
              variant="contained"
              disableElevation
              color="error"
              onClick={() => {
                setClawback(false)
                setConfirming('approve')
              }}
            >
              Aprobar cancelación
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

      {awaitingVerification && (
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

      {/* US-A84 rule 7 — the absorbed history. This is the ONLY surface that can carry a rejected
          request: rejecting it left the folio untouched, so nothing else on the record shows it
          ever happened. */}
      {resolved.length > 0 && (
        <SectionCard>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
            Historial de solicitudes
          </Typography>
          <Stack spacing={1.5}>
            {resolved.map((r) => (
              <Box key={r.id}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {REQUEST_LABEL[r.status] ?? r.status} · {formatDate(r.created_at)}
                </Typography>
                {r.reason && (
                  <Typography variant="body2" color="text.secondary">
                    Motivo del cliente: {r.reason}
                  </Typography>
                )}
                {r.resolution_note && (
                  <Typography variant="body2" color="text.secondary">
                    Resolución: {r.resolution_note}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </SectionCard>
      )}

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
        title="¿Aprobar la cancelación?"
        description="Esto cancela el folio completo: libera todos los lugares, notifica al cliente por correo y — si el folio tiene pago registrado — genera un PIN de reembolso que el cliente verá en su portal."
        confirmLabel={approveRequest.isPending ? 'Aprobando…' : 'Aprobar y cancelar folio'}
        busy={approveRequest.isPending}
        detail={
          <FormControlLabel
            sx={{ alignItems: 'flex-start' }}
            control={
              <Switch
                checked={clawback}
                onChange={(e) => setClawback(e.target.checked)}
                color="error"
              />
            }
            label={
              <Box sx={{ pt: 0.75 }}>
                <Typography variant="body2">Recuperar comisión del agente</Typography>
                <Typography variant="caption" color="text.secondary">
                  {clawback
                    ? 'El agente pierde la comisión generada en esta venta.'
                    : 'Desactivado: la empresa absorbe la pérdida y el agente conserva la comisión.'}
                </Typography>
              </Box>
            }
          />
        }
        error={
          approveRequest.isError ? (
            <Alert severity="error">No se pudo aprobar la solicitud. Inténtalo de nuevo.</Alert>
          ) : null
        }
        onConfirm={() =>
          pending &&
          approveRequest.mutate(
            { id: pending.id, input: { clawback } },
            { onSuccess: () => setConfirming(null) },
          )
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
