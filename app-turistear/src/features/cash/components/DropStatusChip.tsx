import type { ReactElement } from 'react'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import DoNotDisturbOnRounded from '@mui/icons-material/DoNotDisturbOnRounded'
import type { DropStatus } from '../types'
import type { StatusTone } from '../../../components'
import { StatusChip } from '../../../components'

// The cash drop's own lifecycle — the ONE chip a drop row carries. Its signature obligation is a
// separate fact and reads as a quiet neutral note (`AckChip`), not a second coloured pill.
//
// This map lived, byte-identical, in BalancePage, CashBalancesPage and CashDropDetailPage — three
// hand-written copies of one presentation, which is how the seller's and the admin's caja came to
// disagree elsewhere. It also went through a raw MUI `Chip color=…`, so state was carried by
// COLOUR ALONE — the rule the design system calls non-negotiable and BUG-035 was about.
const DROP: Record<DropStatus, { tone: StatusTone; icon: ReactElement; label: string }> = {
  pending: { tone: 'warning', icon: <ScheduleRounded />, label: 'Pendiente' },
  confirmed: { tone: 'success', icon: <CheckCircleRounded />, label: 'Confirmado' },
  rejected: { tone: 'error', icon: <DoNotDisturbOnRounded />, label: 'Rechazado' },
}

export function DropStatusChip({
  status,
  size = 'small',
}: {
  status: DropStatus
  size?: 'small' | 'medium'
}) {
  const { tone, icon, label } = DROP[status]
  return <StatusChip tone={tone} icon={icon} label={label} size={size} />
}
