import { Stack, Typography } from '@mui/material'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import CreditCardRounded from '@mui/icons-material/CreditCardRounded'
import LinkRounded from '@mui/icons-material/LinkRounded'
import UndoRounded from '@mui/icons-material/UndoRounded'
import MoneyOffRounded from '@mui/icons-material/MoneyOffRounded'
import type { ReactElement } from 'react'
import { MoneyText } from '../../../components/MoneyText'
import { StatusChip } from '../../../components/StatusChip'
import { PAYMENT_NOT_RECEIVED_ROW_COPY } from '../../devolada'
import type { CancellationSource } from '../../folios/types'
import type { FolioPaymentEntry, PaymentMethod } from '../types'

const METHOD: Record<PaymentMethod, { label: string; icon: ReactElement }> = {
  cash: { label: 'Efectivo', icon: <PaymentsRounded fontSize="small" /> },
  transfer: { label: 'Transferencia', icon: <AccountBalanceRounded fontSize="small" /> },
  card: { label: 'Tarjeta', icon: <CreditCardRounded fontSize="small" /> },
  link: { label: 'Link de pago', icon: <LinkRounded fontSize="small" /> },
}

const formatDate = (unixSecs: number) =>
  new Date(unixSecs * 1000).toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })

// US-LG08 — the per-payment breakdown on folio detail: each money movement (deposit, balance, a
// cancellation reversal) with its OWN method, so "cash deposit + transfer balance" is legible at a
// glance. Rendered only when a folio was collected in more than one movement — a single-payment
// folio is already summarised by the "Método de pago" line above.
export function PaymentBreakdown({
  payments,
  verificationAuto = false,
  cancellationSource = null,
}: {
  payments: FolioPaymentEntry[]
  /** devolada-transfer-verification D14 — the sale's `verification_auto`: Devolada is verifying
   *  its pending money, with nothing for an admin to do. */
  verificationAuto?: boolean
  /** devolada-transfer-verification D11 — who cancelled the sale (`saleCancellationSource`), null
   *  while it lives. `payment_not_received`: Devolada showed the transfer never arrived. */
  cancellationSource?: CancellationSource | null
}) {
  if (!payments || payments.length < 2) return null
  // D11 — the system withdrew the sale because its transfer never arrived: the row that waited for
  // it is not work for anyone any more, and «Por verificar» would say it still might come.
  const notReceived = cancellationSource === 'payment_not_received'

  return (
    <Stack spacing={1.25}>
      <Typography variant="overline" color="textSecondary">
        Desglose de pagos
      </Typography>
      {payments.map((p) => {
        const isRefund = p.kind === 'refund'
        const meta = METHOD[p.method]
        return (
          <Stack
            key={p.id}
            direction="row"
            spacing={1.5}
            sx={{ alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
              {isRefund ? <UndoRounded fontSize="small" color="error" /> : meta.icon}
              <Stack spacing={0} sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                  {isRefund ? `Reversa · ${meta.label}` : meta.label}
                </Typography>
                <Typography variant="caption" color="textSecondary" noWrap>
                  {formatDate(p.collected_at)}
                  {p.reference ? ` · Ref. ${p.reference}` : ''}
                </Typography>
              </Stack>
            </Stack>

            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
              {/* D14 — «Por verificar» names the admin's work; while Devolada verifies the
                  money there is none, so the row says what is happening to it. D11 — on a sale
                  cancelled because the transfer never arrived, the row says that instead. */}
              {p.verification === 'pending' &&
                (notReceived ? (
                  <StatusChip
                    tone="error"
                    icon={<MoneyOffRounded />}
                    label={PAYMENT_NOT_RECEIVED_ROW_COPY}
                  />
                ) : (
                  <StatusChip
                    status="pending"
                    label={verificationAuto ? 'En verificación' : 'Por verificar'}
                  />
                ))}
              <MoneyText
                cents={p.amount}
                variant="body1"
                signed
                srLabel={isRefund ? 'Reversa' : meta.label}
              />
            </Stack>
          </Stack>
        )
      })}
    </Stack>
  )
}
