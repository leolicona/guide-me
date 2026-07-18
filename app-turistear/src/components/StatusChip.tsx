import { Chip } from '@mui/material'
import type { ChipProps } from '@mui/material'
import type { ReactElement } from 'react'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import CancelRounded from '@mui/icons-material/CancelRounded'
import ErrorRounded from '@mui/icons-material/ErrorRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'

/** Semantic tone — meaning only. Never teal (the brand accent marks action, not state). */
export type StatusTone = 'success' | 'warning' | 'error' | 'neutral'

const TONE_STYLE: Record<StatusTone, { bg: string; fg: string }> = {
  success: { bg: 'var(--color-success-bg, #DCFCE7)', fg: 'var(--color-success-fg, #166534)' },
  warning: { bg: 'var(--color-warning-bg, #FEF3C7)', fg: 'var(--color-warning-fg, #92400E)' },
  error: { bg: 'var(--color-error-bg, #FEE2E2)', fg: 'var(--color-error-fg, #991B1B)' },
  neutral: { bg: 'var(--color-bg-tertiary, #F1F5F9)', fg: 'var(--color-text-secondary, #475569)' },
}

/** Canonical Turistear Ya! statuses → tone + icon. Color is ALWAYS paired with an icon + label so
 *  state is never conveyed by color alone (color-blind safe). */
const PRESET: Record<string, { tone: StatusTone; icon: ReactElement; label: string }> = {
  paid: { tone: 'success', icon: <CheckCircleRounded />, label: 'Pagado' },
  available: { tone: 'success', icon: <CheckCircleRounded />, label: 'Disponible' },
  active: { tone: 'success', icon: <CheckCircleRounded />, label: 'Activo' },
  confirmed: { tone: 'success', icon: <CheckCircleRounded />, label: 'Confirmado' },
  booking: { tone: 'warning', icon: <ScheduleRounded />, label: 'Apartado' },
  pending: { tone: 'warning', icon: <ScheduleRounded />, label: 'Pendiente' },
  expiring: { tone: 'warning', icon: <EventBusyRounded />, label: 'Por vencer' },
  cancelled: { tone: 'error', icon: <CancelRounded />, label: 'Cancelado' },
  dispute: { tone: 'error', icon: <ErrorRounded />, label: 'En disputa' },
  full: { tone: 'error', icon: <BlockRounded />, label: 'Agotado' },
  suspended: { tone: 'neutral', icon: <BlockRounded />, label: 'Suspendido' },
}

export interface StatusChipProps extends Omit<ChipProps, 'color' | 'icon' | 'label'> {
  /** A canonical status key (paid, booking, cancelled, …) — sets tone, icon, and default label. */
  status?: keyof typeof PRESET | string
  /** Override tone when not using a preset. */
  tone?: StatusTone
  /** Override the label text. */
  label?: string
  /** Override the leading icon. */
  icon?: ReactElement
}

/**
 * Functional-color status pill: tinted background + foreground + leading icon. Used for folio,
 * booking, slot, agent, and affiliate states everywhere. Tone is meaning-only and never teal.
 */
export function StatusChip({ status, tone, label, icon, size = 'small', sx, ...rest }: StatusChipProps) {
  const preset = status ? PRESET[status] : undefined
  const resolvedTone: StatusTone = tone ?? preset?.tone ?? 'neutral'
  const resolvedLabel = label ?? preset?.label ?? status ?? ''
  const resolvedIcon = icon ?? preset?.icon
  const style = TONE_STYLE[resolvedTone]

  return (
    <Chip
      size={size}
      icon={resolvedIcon}
      label={resolvedLabel}
      sx={{
        backgroundColor: style.bg,
        color: style.fg,
        fontWeight: 600,
        borderRadius: 'var(--radius-full, 9999px)',
        '& .MuiChip-icon': { color: style.fg, fontSize: 16, ml: 0.5 },
        ...sx,
      }}
      {...rest}
    />
  )
}
