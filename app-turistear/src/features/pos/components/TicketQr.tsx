import { Box, Card, CardContent, Typography, Stack, Chip } from '@mui/material'
import { QRCodeSVG } from 'qrcode.react'
import { ticketPageUrl } from '../delivery'
import type { FolioLine } from '../types'

interface TicketQrProps {
  line: FolioLine
}

// One scannable access ticket per folio line (US-C02). The QR encodes the signed
// token verbatim; the scanner decodes and validates it server-side. Elegant-minimalist:
// flat card with a divider border, generous padding, the QR centered.
export function TicketQr({ line }: TicketQrProps) {
  const passes = line.qr?.passes_total ?? line.quantity

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2} sx={{ alignItems: 'center', textAlign: 'center' }}>
          <Box>
            <Typography variant="subtitle1">{line.service_name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {line.slot_date} · {line.slot_start_time}
            </Typography>
          </Box>

          {line.qr_token ? (
            <>
              <Box
                sx={{
                  p: 2,
                  bgcolor: 'common.white',
                  borderRadius: 2,
                  border: '1px solid',
                  borderColor: 'divider',
                  lineHeight: 0,
                }}
              >
                {/* US-T07 (D9) — the URL form: a tourist's camera lands on /t/<token>. */}
                {/* `qrcode.react` renders `role="img"` with no accessible name, which axe reports
                    as a serious violation — found when US-A93 put this card on a screen the a11y
                    suite actually runs against. The code itself is unusable by a screen reader;
                    what it needs is to be NAMED, since the passes and the departure beside it are
                    already text. */}
                <QRCodeSVG
                  value={ticketPageUrl(line.qr_token)}
                  size={176}
                  level="M"
                  aria-label={`Código QR del boleto — ${line.service_name}`}
                />
              </Box>
              <Chip
                size="small"
                variant="outlined"
                label={`${passes} ${passes === 1 ? 'pase' : 'pases'}`}
              />
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No hay boleto disponible para esta línea.
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}
