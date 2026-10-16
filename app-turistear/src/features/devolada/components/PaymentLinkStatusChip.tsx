import type { ReactElement } from 'react'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
import CurrencyExchangeRounded from '@mui/icons-material/CurrencyExchangeRounded'
import DonutLargeRounded from '@mui/icons-material/DonutLargeRounded'
import CancelRounded from '@mui/icons-material/CancelRounded'
import MoneyOffRounded from '@mui/icons-material/MoneyOffRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import PauseCircleRounded from '@mui/icons-material/PauseCircleRounded'
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded'
import HourglassTopRounded from '@mui/icons-material/HourglassTopRounded'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import { StatusChip } from '../../../components'
import type { StatusTone } from '../../../components'
import { PAYMENT_LINK_LABEL_COPY, type PaymentLinkTone } from '../copy'
import type { PaymentLinkLabel } from '../types'

// devolada-transfer-verification D14, D16 — one chip per label the server decided. Every chip pairs
// its colour with an icon and the text, so state is never colour alone (constitution VII).
const ICON: Record<PaymentLinkLabel, ReactElement> = {
  link_failed: <LinkOffRounded />,
  confirmed: <CheckCircleRounded />,
  unapplied: <CurrencyExchangeRounded />,
  partial: <DonutLargeRounded />,
  invalid: <CancelRounded />,
  not_received: <MoneyOffRounded />,
  closed: <BlockRounded />,
  credit_paused: <PauseCircleRounded />,
  needs_tracking_key: <ReceiptLongRounded />,
  validating: <HourglassTopRounded />,
  awaiting_payment: <ScheduleRounded />,
}

// The contract's tones onto the primitive's: «pending» is a wait, shown as warning (like the
// `pending` preset), and «paid» is success.
const TONE: Record<PaymentLinkTone, StatusTone> = {
  paid: 'success',
  pending: 'warning',
  warning: 'warning',
  error: 'error',
  neutral: 'neutral',
}

export function PaymentLinkStatusChip({ label }: { label: PaymentLinkLabel }) {
  const { text, tone } = PAYMENT_LINK_LABEL_COPY[label]
  return <StatusChip tone={TONE[tone]} icon={ICON[label]} label={text} />
}
