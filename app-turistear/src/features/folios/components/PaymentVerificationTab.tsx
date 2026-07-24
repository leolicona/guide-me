import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import { usePendingVerificationFolios } from '../hooks'
import {
  useVerifyPayment,
  useRejectPayment,
  useMarkTicketsSent,
} from '../../bookings'
import { useMyOrganization, useOrgDateFormatter } from '../../organization'
import { useMe } from '../../auth/hooks/useMe'
import { ticketWhatsAppUrl, DEFAULT_TICKET_TEMPLATE } from '../../pos/delivery'
import { MoneyText } from '../../../components'
import type { FolioListItem } from '../types'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// US-A67 — the admin "Por verificar" queue: electronic (transfer) payments awaiting confirmation
// against the bank, using the reference the seller recorded. Verifying releases the tickets (the
// server signs the QR + auto-emails); "Verificar y enviar" also opens the admin's WhatsApp; Rechazar
// voids the folio (releases spots + commission clawback). The AGENT sends by default — once verified,
// their own WhatsApp button unlocks — so the admin-WhatsApp path is the fallback.
export function PaymentVerificationTab() {
  const { data: folios, isLoading, isError } = usePendingVerificationFolios()
  const { data: org } = useMyOrganization()
  const { data: me } = useMe()
  const verify = useVerifyPayment()
  const reject = useRejectPayment()
  const markSent = useMarkTicketsSent('admin')
  const formatDate = useOrgDateFormatter(DATE_FMT)

  const [rejecting, setRejecting] = useState<FolioListItem | null>(null)
  const [reason, setReason] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const busyId = verify.isPending ? verify.variables : null

  const kindLabel = (f: FolioListItem) =>
    f.status === 'booking' ? 'Apartado (anticipo)' : 'Venta / liquidación'

  // Verify, then open the admin's WhatsApp with the freshly-minted portal link + stamp Enviado.
  const verifyAndSend = (f: FolioListItem) => {
    verify.mutate(f.id, {
      onSuccess: (folio) => {
        setToast('Pago verificado')
        const template = org?.wa_ticket_template || DEFAULT_TICKET_TEMPLATE
        const url = ticketWhatsAppUrl(template, {
          folio,
          agentName: me?.name ?? '',
          orgName: org?.name ?? 'Turistear Ya!',
          portalLink: folio.portal_link ?? '',
        })
        if (url) {
          window.open(url, '_blank')
          markSent.mutate(folio.id)
        }
      },
    })
  }

  const verifyOnly = (f: FolioListItem) =>
    verify.mutate(f.id, { onSuccess: () => setToast('Pago verificado · boletos liberados') })

  const confirmReject = () => {
    if (!rejecting) return
    reject.mutate(
      { id: rejecting.id, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setToast('Pago rechazado · venta cancelada')
          setRejecting(null)
          setReason('')
        },
      },
    )
  }

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    )
  }
  if (isError) {
    return <Alert severity="error">No se pudo cargar la cola de verificación. Inténtalo de nuevo.</Alert>
  }
  if (!folios || folios.length === 0) {
    return (
      <Stack spacing={1.5} sx={{ alignItems: 'center', py: 6, color: 'text.secondary' }}>
        <CheckCircleRounded sx={{ fontSize: 40, color: 'success.main' }} />
        <Typography>No hay pagos por verificar.</Typography>
      </Stack>
    )
  }

  return (
    <>
      <Stack spacing={2}>
        {folios.map((f) => {
          const busy = busyId === f.id || (reject.isPending && rejecting?.id === f.id)
          return (
            <Card key={f.id}>
              <CardContent>
                <Stack
                  direction="row"
                  sx={{ justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}
                >
                  <Box>
                    <Typography sx={{ fontWeight: 600 }}>
                      {f.customer_name ?? 'Cliente'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {f.agent.name} · {formatDate(f.created_at)}
                    </Typography>
                  </Box>
                  <Chip
                    size="small"
                    icon={<AccountBalanceRounded />}
                    label="Transferencia"
                    variant="outlined"
                  />
                </Stack>

                <Stack
                  direction="row"
                  spacing={2}
                  sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }}
                >
                  <MoneyText cents={f.total} />
                  <Chip size="small" label={kindLabel(f)} />
                  {f.payment_reference && (
                    <Typography variant="body2" color="text.secondary">
                      Ref: <b>{f.payment_reference}</b>
                    </Typography>
                  )}
                </Stack>

                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                  <Button
                    variant="contained"
                    disableElevation
                    startIcon={<CheckCircleRounded />}
                    disabled={busy}
                    onClick={() => verifyOnly(f)}
                  >
                    Verificar
                  </Button>
                  <Button
                    variant="outlined"
                    color="success"
                    startIcon={<WhatsAppIcon />}
                    disabled={busy}
                    onClick={() => verifyAndSend(f)}
                  >
                    Verificar y enviar
                  </Button>
                  <Button
                    color="error"
                    disabled={busy}
                    onClick={() => {
                      setRejecting(f)
                      setReason('')
                    }}
                  >
                    Rechazar
                  </Button>
                </Stack>
              </CardContent>
            </Card>
          )
        })}
      </Stack>

      <Dialog open={!!rejecting} onClose={() => setRejecting(null)} fullWidth maxWidth="xs">
        <DialogTitle>Rechazar pago</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            La venta se cancelará: se liberan los lugares y se descuenta la comisión del vendedor.
          </DialogContentText>
          <TextField
            label="Motivo (opcional)"
            placeholder="Ej. No se recibió la transferencia"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            fullWidth
            multiline
            minRows={2}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejecting(null)}>Cancelar</Button>
          <Button color="error" variant="contained" disableElevation onClick={confirmReject}>
            Rechazar venta
          </Button>
        </DialogActions>
      </Dialog>

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
