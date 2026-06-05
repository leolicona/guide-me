import { Box, Typography, Stack, Card, CardContent } from '@mui/material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import CancelRounded from '@mui/icons-material/CancelRounded'
import type { ScanResult as ScanResultData, ScanReason, ScannedTicket } from '../types'

// US-AG17 — the scan-result screen. Big ✓/✗, then the human reason and whatever ticket
// context the server could attach (client / service / schedule), plus the redemption
// progress on a valid scan.

const REASON_COPY: Record<ScanReason, string> = {
  ALREADY_CONSUMED: 'All passes already used.',
  EXPIRED: 'This ticket has expired.',
  INVALID_SIGNATURE: 'Not a valid GuideMe ticket.',
  CANCELLED: 'This folio was cancelled.',
  NOT_PAID: "This folio isn't fully paid yet.",
  NOT_FOUND: 'Ticket not found.',
}

const reasonCopy = (reason: ScanReason, t: ScannedTicket | null): string => {
  if (reason === 'ALREADY_CONSUMED' && t?.passes_total != null) {
    return `All passes already used (${t.passes_total} of ${t.passes_total}).`
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
            {isValid ? 'Valid ticket' : 'Invalid ticket'}
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
              Pass {t.pass_number} of {t.passes_total} used
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}
