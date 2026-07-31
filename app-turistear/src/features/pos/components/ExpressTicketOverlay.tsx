import { useEffect } from 'react'
import { Box, Dialog, Typography, Button, Stack } from '@mui/material'
import { QRCodeSVG } from 'qrcode.react'
import { ticketPageUrl } from '../delivery'
import { formatMoney } from '../../catalog/types'

interface ExpressTicketOverlayProps {
  /** The line's signed token; null keeps the overlay closed. */
  qrToken: string | null
  serviceName: string
  slotLabel: string // "Hoy · 16:00"
  passes: number
  total: number
  onClose: () => void
}

// US-T07 / US-AG45 (D20) — the counter-handoff surface: the QR full-bleed on PURE WHITE at
// ≥280px / level L (a dense URL-form token scanned off another phone's screen, possibly in
// direct sun — the design system's first law is the constraint here). Auto-hides after ~20s so
// the code isn't left exposed to the next customer in the queue; re-opened by "Mostrar QR".
const AUTO_HIDE_MS = 20_000

export function ExpressTicketOverlay({
  qrToken,
  serviceName,
  slotLabel,
  passes,
  total,
  onClose,
}: ExpressTicketOverlayProps) {
  useEffect(() => {
    if (!qrToken) return
    const t = setTimeout(onClose, AUTO_HIDE_MS)
    return () => clearTimeout(t)
  }, [qrToken, onClose])

  return (
    <Dialog
      fullScreen
      open={qrToken !== null}
      onClose={onClose}
      // Deliberately NOT the BottomSheet: this is a display surface the customer photographs,
      // not an editing overlay — maximum area, maximum contrast, zero chrome.
      slotProps={{ paper: { sx: { bgcolor: '#FFFFFF' } } }}
    >
      <Stack
        spacing={3}
        sx={{
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          px: 3,
          textAlign: 'center',
        }}
      >
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {serviceName}
          </Typography>
          <Typography color="text.secondary">
            {slotLabel} · {passes} {passes === 1 ? 'pase' : 'pases'} ·{' '}
            <Box component="span" className="numeric">
              {formatMoney(total)}
            </Box>
          </Typography>
        </Box>

        {qrToken && (
          <QRCodeSVG value={ticketPageUrl(qrToken)} size={300} level="L" />
        )}

        <Typography color="text.secondary">
          El cliente escanea este código con la cámara de su teléfono
          <br />y su boleto queda entregado.
        </Typography>

        <Button variant="outlined" size="large" onClick={onClose} sx={{ minWidth: 200 }}>
          Listo
        </Button>
      </Stack>
    </Dialog>
  )
}
