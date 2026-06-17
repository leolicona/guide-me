import {
  Box,
  Typography,
  Card,
  CardContent,
  Stack,
  Button,
  Chip,
  IconButton,
  Fade,
  CircularProgress,
  Alert,
  Divider,
} from '@mui/material'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import PaidRounded from '@mui/icons-material/PaidRounded'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import {
  useMyFolios,
  useMyOrganization,
  useSettleBooking,
  useCancelBooking,
  useClaimReminder,
} from '../features/pos/hooks'
import { useMe } from '../features/auth/hooks/useMe'
import { formatMoney } from '../features/catalog/types'
import type { FolioHistoryItem } from '../features/pos/types'

const HOUR = 3600

// Hours until expiry (negative once past). Drives the urgency border + chip.
const hoursUntil = (expiresAt: number | null | undefined): number | null =>
  expiresAt == null ? null : (expiresAt - Date.now() / 1000) / HOUR

const venceLabel = (expiresAt: number | null | undefined): string => {
  const h = hoursUntil(expiresAt)
  if (h == null) return ''
  if (h <= 0) return 'Vencido'
  if (h < 1) return `Vence en ${Math.round(h * 60)} min`
  if (h < 24) return `Vence en ${Math.round(h)} h`
  return `Vence en ${Math.round(h / 24)} d`
}

export default function BookingsDashboardPage() {
  const { data: me } = useMe()
  const { data: org } = useMyOrganization()
  const { data: folios, isLoading, isError } = useMyFolios({ status: 'booking' })
  const settle = useSettleBooking()
  const cancel = useCancelBooking()
  const reminder = useClaimReminder()

  // Sort by expiry urgency — closest first (US-AG07.3 Sc.1).
  const sorted = [...(folios ?? [])].sort(
    (a, b) =>
      (a.booking_expires_at ?? Infinity) - (b.booking_expires_at ?? Infinity),
  )

  const openWhatsApp = (folio: FolioHistoryItem) => {
    const phone = (folio.customer_phone ?? '').replace(/\D/g, '')
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

  // US-AG07.3 D6 — pre-flight atomic claim BEFORE opening WhatsApp, so two viewers never both send.
  const onWhatsApp = (folio: FolioHistoryItem) => {
    reminder.mutate(
      { id: folio.id },
      {
        onSuccess: (res) => {
          if (res.claimed) {
            openWhatsApp(folio)
          } else {
            const at = res.reminder_sent_at
              ? new Date(res.reminder_sent_at * 1000).toLocaleTimeString('es-MX', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : ''
            if (window.confirm(`Ya contactado${at ? ` a las ${at}` : ''}. ¿Reenviar?`)) {
              reminder.mutate(
                { id: folio.id, force: true },
                { onSuccess: () => openWhatsApp(folio) },
              )
            }
          }
        },
      },
    )
  }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Apartados
        </Typography>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && <Alert severity="error">No se pudieron cargar los apartados.</Alert>}

        {!isLoading && !isError && sorted.length === 0 && (
          <Typography color="text.secondary">No tienes apartados abiertos.</Typography>
        )}

        <Stack spacing={2}>
          {sorted.map((folio) => {
            const urgent = (hoursUntil(folio.booking_expires_at) ?? Infinity) < 24
            const reminded = folio.reminder_status === 'sent'
            const busy =
              settle.isPending || cancel.isPending || reminder.isPending
            return (
              <Card
                key={folio.id}
                sx={{
                  borderLeft: '4px solid',
                  borderLeftColor: urgent ? 'warning.main' : 'divider',
                }}
              >
                <CardContent>
                  <Stack
                    direction="row"
                    sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle1" noWrap>
                        {folio.customer_name ?? 'Cliente'}
                      </Typography>
                      <Chip
                        size="small"
                        label={venceLabel(folio.booking_expires_at)}
                        color={urgent ? 'warning' : 'default'}
                        variant="outlined"
                        sx={{ mt: 0.5 }}
                      />
                    </Box>
                    <Box sx={{ textAlign: 'right' }}>
                      <Typography variant="caption" color="text.secondary">
                        Saldo pendiente
                      </Typography>
                      <Typography variant="h6" color="primary">
                        {formatMoney(folio.pending_balance ?? 0)}
                      </Typography>
                    </Box>
                  </Stack>

                  <Divider sx={{ my: 1.5 }} />

                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <IconButton
                      aria-label="Recordar por WhatsApp"
                      color="success"
                      disabled={busy || !folio.customer_phone}
                      onClick={() => onWhatsApp(folio)}
                      sx={{ opacity: reminded ? 0.5 : 1 }}
                    >
                      <WhatsAppIcon />
                    </IconButton>
                    <Box sx={{ flex: 1 }} />
                    <Button
                      size="small"
                      color="inherit"
                      startIcon={<EventBusyRounded />}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm('¿Cancelar el apartado y liberar los lugares? El anticipo no es reembolsable.')) {
                          cancel.mutate({ id: folio.id })
                        }
                      }}
                    >
                      Cancelar
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      disableElevation
                      startIcon={<PaidRounded />}
                      disabled={busy}
                      onClick={() => settle.mutate(folio.id)}
                    >
                      Liquidar
                    </Button>
                  </Stack>
                </CardContent>
              </Card>
            )
          })}
        </Stack>
      </Box>
    </Fade>
  )
}
