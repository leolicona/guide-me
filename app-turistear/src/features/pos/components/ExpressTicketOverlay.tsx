import { useEffect } from 'react'
import { Box, Dialog, Typography, Button, Stack } from '@mui/material'
import UndoRounded from '@mui/icons-material/UndoRounded'
import { QRCodeSVG } from 'qrcode.react'
import { ticketPageUrl } from '../delivery'
import { formatMoney } from '../../catalog/types'
import { TicketWhatsAppButton } from '../../bookings/components/TicketWhatsAppButton'
import type { Folio } from '../types'

interface ExpressTicketOverlayProps {
  /** The line's signed token; null keeps the overlay closed. */
  qrToken: string | null
  serviceName: string
  slotLabel: string // "Hoy · 16:00"
  passes: number
  total: number
  /** The sale just closed — powers the WhatsApp send from this screen. Null before any sale. */
  folio: Folio | null
  /** US-AG47 — whether the 60s void window is still open (the owner tracks it). */
  inVoidWindow: boolean
  voiding: boolean
  onVoid: () => void
  onClose: () => void
}

// US-T07 / US-AG45 (D20, amended) — the counter-handoff surface IS the confirmation surface:
// the QR full-bleed on PURE WHITE at ≥280px / level L (a dense URL-form token scanned off
// another phone's screen, possibly in direct sun), with the sale's actions ON the same screen —
// WhatsApp for the customer who asks for the receipt instead of scanning, Deshacer while the 60s
// window lasts, and one primary "Siguiente venta" back to the reset form. Merging the two
// surfaces removes the Listo → strip hop: Cobrar lands here, one tap returns to selling.
// Auto-hides after ~20s so the code isn't left exposed to the queue; re-opened by "Mostrar QR".
const AUTO_HIDE_MS = 20_000

export function ExpressTicketOverlay({
  qrToken,
  serviceName,
  slotLabel,
  passes,
  total,
  folio,
  inVoidWindow,
  voiding,
  onVoid,
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
        spacing={2.5}
        sx={{
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          px: 3,
          textAlign: 'center',
        }}
      >
        {/* Sale info — the confirmation the footer strip used to carry. */}
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, color: 'success.main' }}>
            ✓ Venta cobrada
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {serviceName}
          </Typography>
          <Typography color="text.secondary">
            {slotLabel} · {passes} {passes === 1 ? 'pase' : 'pases'} ·{' '}
            <Box component="span" className="numeric" sx={{ fontWeight: 700 }}>
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

        {/* The sale's actions, on the same screen as its QR (amended in build): WhatsApp for
            the customer who asks for the receipt instead of scanning; Deshacer while the 60s
            window lasts. Sending by WhatsApp marks the tickets delivered, which closes the
            void window — the server enforces that order regardless of what renders here. */}
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          {folio && <TicketWhatsAppButton folio={folio} variant="icon" />}
          {inVoidWindow && (
            <Button
              size="small"
              color="error"
              startIcon={<UndoRounded />}
              disabled={voiding}
              onClick={onVoid}
            >
              Deshacer
            </Button>
          )}
        </Stack>

        <Button
          variant="contained"
          color="secondary"
          size="large"
          onClick={onClose}
          sx={{ minWidth: 220 }}
        >
          Siguiente venta
        </Button>
      </Stack>
    </Dialog>
  )
}
