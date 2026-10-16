import type { ReactNode } from 'react'
import { Stack, TextField, Typography } from '@mui/material'
import HourglassTopRounded from '@mui/icons-material/HourglassTopRounded'
import LinkRounded from '@mui/icons-material/LinkRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import {
  TRANSFER_BROKEN_COPY,
  TRANSFER_BY_LINK_COPY,
  type OrganizationDevoladaSummary,
} from '../../devolada'

export interface TransferPaymentFieldsProps {
  /** The organization's Devolada connection (`MyOrganization.devolada`); absent = never connected. */
  devolada?: OrganizationDevoladaSummary
  /** The transfer pays an apartado's deposit, which keeps today's manual path, reference included,
   *  until deposits get their enlace (devolada-transfer-verification T058). */
  deposit?: boolean
  /** US-A88 — the org's `payment_reference_required`. */
  referenceRequired: boolean
  reference: string
  onReferenceChange: (reference: string) => void
}

// Structured, at-a-glance consequence of the selection: one glyph, one caption.
function ConsequenceLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{ alignItems: 'center', mt: 1.5, color: 'text.secondary' }}
    >
      {icon}
      <Typography variant="caption">{children}</Typography>
    </Stack>
  )
}

// US-AG41 — what picking Transferencia asks of the seller, and what it sets in motion, by the
// organization's Devolada connection (devolada-transfer-verification D6, D16):
// - connected, on a full sale: an enlace collects the money, so no reference is offered (FR-009);
// - broken: today's manual path, and the seller is told why (FR-010);
// - otherwise: the bank reference (optional per org, US-A88), the money held for an admin (US-A67).
export function TransferPaymentFields({
  devolada,
  deposit = false,
  referenceRequired,
  reference,
  onReferenceChange,
}: TransferPaymentFieldsProps) {
  // D6 — mirrors confirmSale's `collectsByLink`, as PosCheckoutPage does for the request.
  if (devolada?.status === 'connected' && !deposit) {
    return (
      <ConsequenceLine icon={<LinkRounded sx={{ fontSize: 18 }} />}>
        {TRANSFER_BY_LINK_COPY}
      </ConsequenceLine>
    )
  }

  // US-A88 — optional still means "4+ characters if present": an empty field passes, a partial
  // one doesn't.
  const trimmed = reference.trim()
  const referenceValid = trimmed.length >= 4 || (!referenceRequired && trimmed.length === 0)

  return (
    <>
      {/* The QR is held until an admin verifies, with or without a reference. */}
      <TextField
        label={
          referenceRequired
            ? 'Referencia de la transferencia'
            : 'Referencia de la transferencia (opcional)'
        }
        placeholder="Ej. BBVA 0099887766"
        value={reference}
        onChange={(e) => onReferenceChange(e.target.value)}
        error={trimmed.length > 0 && !referenceValid}
        helperText={
          trimmed.length > 0 && !referenceValid
            ? 'Captura al menos 4 caracteres.'
            : 'Número o folio del comprobante — el administrador lo verifica.'
        }
        fullWidth
        sx={{ mt: 2 }}
      />
      <ConsequenceLine icon={<HourglassTopRounded sx={{ fontSize: 18 }} />}>
        En verificación · los boletos se envían al confirmar el pago
      </ConsequenceLine>
      {devolada?.status === 'broken' && (
        <ConsequenceLine
          icon={<WarningAmberRounded sx={{ fontSize: 18, color: 'warning.main' }} />}
        >
          {TRANSFER_BROKEN_COPY}
        </ConsequenceLine>
      )}
    </>
  )
}
