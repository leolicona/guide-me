import type { ReactElement } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import EventAvailableRounded from '@mui/icons-material/EventAvailableRounded'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import HourglassTopRounded from '@mui/icons-material/HourglassTopRounded'
import { SectionCard, StatusChip } from '../../../components'
import type { FolioStatus, PaymentVerification } from '../types'

/** What the receipt reads from the sale to say where its money stands. */
export interface ReceiptStatusFolio {
  status: FolioStatus
  booking_expires_at?: number | null
  payment_verification?: PaymentVerification
  /** devolada-transfer-verification D14 — Devolada is verifying the money, with nothing for an
   *  admin to do. */
  verification_auto?: boolean
}

type ReceiptState = 'booking' | 'expired_booking' | 'cancelled' | 'unverified' | 'confirmed'

// devolada-transfer-verification D16 (research, defect 7) — the receipt said «Venta confirmada»
// and «Pagado» for a transfer nobody had verified. The rule lives here, outside `pages/`, so it
// can be tested (constitution VI). A cancelled sale that carries a booking expiry was an apartado
// (US-AG07.5 late arrival); any other cancelled sale keeps today's header.
function receiptState(folio: ReceiptStatusFolio): ReceiptState {
  if (folio.status === 'booking') return 'booking'
  if (folio.status === 'cancelled') {
    return folio.booking_expires_at != null ? 'expired_booking' : 'cancelled'
  }
  return folio.payment_verification === 'pending' ? 'unverified' : 'confirmed'
}

const HEADER: Record<ReceiptState, { icon: ReactElement; title: string }> = {
  booking: {
    icon: <EventAvailableRounded color="warning" sx={{ fontSize: 48 }} />,
    title: 'Apartado registrado',
  },
  expired_booking: {
    icon: <EventBusyRounded color="disabled" sx={{ fontSize: 48 }} />,
    title: 'Apartado vencido',
  },
  cancelled: {
    icon: <CheckCircleRounded color="success" sx={{ fontSize: 48 }} />,
    title: 'Venta confirmada',
  },
  unverified: {
    icon: <HourglassTopRounded color="warning" sx={{ fontSize: 48 }} />,
    title: 'Pago en verificación',
  },
  confirmed: {
    icon: <CheckCircleRounded color="success" sx={{ fontSize: 48 }} />,
    title: 'Venta confirmada',
  },
}

/** The receipt's status line: its glyph and its heading. */
export function ReceiptPaymentStatus({ folio }: { folio: ReceiptStatusFolio }) {
  const { icon, title } = HEADER[receiptState(folio)]
  return (
    <>
      {icon}
      <Typography variant="h5" component="h1" sx={{ mt: 1 }}>
        {title}
      </Typography>
    </>
  )
}

/** The chip beside «Recibo». */
export function ReceiptPaymentChip({ folio }: { folio: ReceiptStatusFolio }) {
  const state = receiptState(folio)
  // Unverified money is not «Pagado»: the pending preset, icon-paired, in the word the UI has for
  // money being checked (research D16).
  if (state === 'unverified') return <StatusChip status="pending" label="En verificación" />
  const booking = state === 'booking'
  const cancelled = state === 'cancelled' || state === 'expired_booking'
  return (
    <Chip
      size="small"
      color={booking ? 'warning' : cancelled ? 'default' : 'success'}
      variant="outlined"
      label={booking ? 'Apartado' : cancelled ? 'Cancelado' : 'Pagado'}
    />
  )
}

/**
 * US-A67 — a transfer whose money an admin has not verified yet: no QR, no delivery. Where the
 * status line already reads «Pago en verificación», the note explains it without saying it twice.
 * Never on a sale Devolada is verifying (D14): «un administrador» would name work the admin does
 * not have, and the enlace card says where the payment stands.
 */
export function ReceiptVerificationNote({ folio }: { folio: ReceiptStatusFolio }) {
  if (folio.payment_verification !== 'pending' || folio.verification_auto) return null
  const titled = true
  return (
    <SectionCard>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <HourglassTopRounded sx={{ color: 'warning.main', mt: 0.25 }} />
        <Box>
          {titled && (
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              Pago en verificación
            </Typography>
          )}
          <Typography variant="body2" color="textSecondary">
            Los boletos se enviarán en cuanto un administrador confirme la transferencia.
          </Typography>
        </Box>
      </Stack>
    </SectionCard>
  )
}
