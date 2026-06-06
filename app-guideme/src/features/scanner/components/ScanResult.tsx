import { Box, Typography, Stack, Card, CardContent } from '@mui/material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import CancelRounded from '@mui/icons-material/CancelRounded'
import type { ScanResult as ScanResultData, ScanReason, ScannedTicket } from '../types'

// US-AG17 — the scan-result screen. Big ✓/✗, then the human reason and whatever ticket
// context the server could attach (client / service / schedule), plus the redemption
// progress on a valid scan.

const REASON_COPY: Record<ScanReason, string> = {
  ALREADY_CONSUMED: 'Todos los pases ya han sido utilizados.',
  EXPIRED: 'Este boleto ha expirado.',
  INVALID_SIGNATURE: 'No es un boleto válido de GuideMe.',
  CANCELLED: 'Este folio fue cancelado.',
  NOT_PAID: 'Este folio aún no está totalmente pagado.',
  NOT_FOUND: 'Boleto no encontrado.',
}

const reasonCopy = (reason: ScanReason, t: ScannedTicket | null): string => {
  if (reason === 'ALREADY_CONSUMED' && t?.passes_total != null) {
    return `Todos los pases ya han sido utilizados (${t.passes_total} de ${t.passes_total}).`
  }
  return REASON_COPY[reason]
}

interface ScanResultProps {
  result: ScanResultData
}

export function ScanResult({ result }: ScanResultProps) {
  const isValid = result.result === 'valid'
  const t = result.ticket
  const hasContext = !!t && (!!t.client_identity || !!t.service_name)

  return (
    <Card
      variant="outlined"
      sx={{ borderColor: isValid ? 'success.main' : 'error.main' }}
    >
      <CardContent>
        <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center' }}>
          {isValid ? (
            <CheckCircleRounded color="success" sx={{ fontSize: 64 }} />
          ) : (
            <CancelRounded color="error" sx={{ fontSize: 64 }} />
          )}

          <Typography variant="h6">
            {isValid ? 'Boleto válido' : 'Boleto inválido'}
          </Typography>

          {!isValid && result.reason && (
            <Typography color="error.main">
              {reasonCopy(result.reason, t)}
            </Typography>
          )}

          {hasContext && (
            <Box>
              {t!.client_identity && (
                <Typography variant="body1">{t!.client_identity}</Typography>
              )}
              {t!.service_name && (
                <Typography variant="body2" color="text.secondary">
                  {t!.service_name}
                </Typography>
              )}
              {(t!.slot_date || t!.slot_start_time) && (
                <Typography variant="caption" color="text.secondary">
                  {t!.slot_date} · {t!.slot_start_time}
                </Typography>
              )}
            </Box>
          )}

          {isValid && t?.pass_number != null && t?.passes_total != null && (
            <Typography variant="h5" sx={{ mt: 1 }}>
              Pase {t.pass_number} de {t.passes_total} utilizado
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}
