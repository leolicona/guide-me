import { useEffect } from 'react'
import { Box, Typography, IconButton, Stack } from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import { QRCodeSVG } from 'qrcode.react'
import { ticketPageUrl } from '../delivery'
import { formatMoney } from '../../catalog/types'

interface ExpressTicketOverlayProps {
  /** The line's signed token; null keeps the panel closed. */
  qrToken: string | null
  serviceName: string
  slotLabel: string // "Hoy · 16:00"
  passes: number
  total: number
  onClose: () => void
}

// US-T07 / US-AG45 (D20, amended in build) — the counter-handoff surface, NON-BLOCKING: a panel
// docked in the lower half of the express sheet, QR on PURE WHITE at 280px / level L (a dense
// URL-form token scanned off another phone's screen, possibly in direct sun — the design system's
// first law is the constraint). The form above stays live, so the agent starts the NEXT sale
// while this customer is still scanning. Auto-hides after ~20s so the code isn't left exposed to
// the queue; re-opened by "Mostrar QR". Not a Dialog on purpose: a modal backdrop would block
// exactly the selling loop Express exists to protect.
const AUTO_HIDE_MS = 20_000
const QR_SIZE = 280

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

  if (!qrToken) return null

  return (
    <Box
      sx={{
        flexShrink: 0,
        position: 'relative',
        // A confident teal top edge marks it as the handoff zone; the surface itself is pure
        // white for maximum scan contrast — the one place brighter than the sheet around it.
        borderTop: '2px solid',
        borderColor: 'secondary.main',
        bgcolor: '#FFFFFF',
        px: 3,
        pt: 1.5,
        pb: 2,
        textAlign: 'center',
      }}
    >
      <IconButton
        size="small"
        aria-label="Ocultar código QR"
        onClick={onClose}
        sx={{ position: 'absolute', top: 6, right: 8 }}
      >
        <CloseRounded fontSize="small" />
      </IconButton>

      <Stack spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          {serviceName} · {slotLabel} · {passes} {passes === 1 ? 'pase' : 'pases'} ·{' '}
          <Box component="span" className="numeric" sx={{ fontWeight: 700 }}>
            {formatMoney(total)}
          </Box>
        </Typography>

        <QRCodeSVG value={ticketPageUrl(qrToken)} size={QR_SIZE} level="L" />

        <Typography variant="caption" color="text.secondary">
          El cliente escanea con la cámara de su teléfono — su boleto queda entregado.
        </Typography>
      </Stack>
    </Box>
  )
}
