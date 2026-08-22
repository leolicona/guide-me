import { Box, Stack, Typography } from '@mui/material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import { MoneyText } from '../../../components'
import { formatMoney } from '../../catalog/types'
import type { FolioStatus, RefundStatus } from '../types'

// US-AG59 (folio-surface-parity D6/D7) — what a cancellation DID to the money, and what a close
// left the customer. One component, both details.
//
// It exists because the admin's detail had these rows and the seller's had nothing: a cancelled
// folio read «Pagado $3,000» and stopped (BUG-034), on the one screen the person standing in front
// of the customer can open. Copying the admin's JSX would have made a second copy of the thing that
// already drifted once — so the rows move here and both pages render this.
//
// Rendered inside the payment card's money stack: these are facts about the SALE's money, and they
// belong on the surface that already owns money. The WHEN and the WHO stay the Historial's.

export interface FolioMoneyOutcomeFolio {
  status: FolioStatus
  amount_paid: number
  refund_status?: RefundStatus
  refund_amount?: number | null
  credit_amount?: number | null
  credit_expires_at?: number | null
}

export interface FolioMoneyOutcomeProps {
  folio: FolioMoneyOutcomeFolio
  /** The page's org-local formatter — the credit's expiry is a date the customer is told. */
  formatDate: (unixSeconds: number) => string
}

export function FolioMoneyOutcome({ folio, formatDate }: FolioMoneyOutcomeProps) {
  const isCancelled = folio.status === 'cancelled'
  const refunded = folio.refund_amount ?? 0
  const retained = folio.amount_paid - refunded
  const credit = folio.credit_amount ?? 0

  return (
    <>
      {/* The cancellation's money OUTCOME — the same «Se devuelve / La empresa retiene» pair the
          RefundQuote previewed before the admin committed: the quote was the decision's preview,
          this is its record. `refund_status: 'none'` with money paid is the 0%-ladder case — full
          retention, said out loud, because that is exactly where silence confuses most. */}
      {isCancelled && folio.amount_paid > 0 && (
        <>
          {refunded > 0 && (
            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
              <Box>
                <Typography color="text.secondary">Se devuelve al cliente</Typography>
                {/* Delivery state is icon-paired on the row (never colour-alone). */}
                {folio.refund_status === 'refunded' ? (
                  <Typography
                    variant="caption"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.5,
                      color: 'success.main',
                      fontWeight: 600,
                    }}
                  >
                    <CheckCircleRounded sx={{ fontSize: 14 }} />
                    Entregado
                  </Typography>
                ) : (
                  <Typography
                    variant="caption"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.5,
                      color: 'warning.main',
                      fontWeight: 600,
                    }}
                  >
                    <ScheduleRounded sx={{ fontSize: 14 }} />
                    Por entregar
                  </Typography>
                )}
              </Box>
              <Typography className="numeric">{formatMoney(refunded)}</Typography>
            </Stack>
          )}
          {retained > 0 && (
            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
              <Typography color="text.secondary">La empresa retiene</Typography>
              <Typography className="numeric">{formatMoney(retained)}</Typography>
            </Stack>
          )}
        </>
      )}

      {/* US-A87 (D6/D10) — what the close left the customer, and until when. This is the number the
          agent honours by MANUAL DISCOUNT while the checkout cannot spend it — which is precisely
          why it must reach the seller's screen and not only the admin's. Positive green: it is the
          customer's money, not the company's. */}
      {credit > 0 && (
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Box>
            <Typography color="text.secondary">Saldo a favor del cliente</Typography>
            {folio.credit_expires_at && (
              <Typography variant="caption" color="text.secondary">
                Vigente hasta el {formatDate(folio.credit_expires_at)}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              Se aplica como descuento manual en una venta nueva
            </Typography>
          </Box>
          <MoneyText
            cents={credit}
            variant="h6"
            semantic="positive"
            srLabel="Saldo a favor del cliente"
          />
        </Stack>
      )}
    </>
  )
}
