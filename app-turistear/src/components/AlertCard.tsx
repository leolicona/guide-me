import { Box, Typography } from '@mui/material'
import type { ReactNode, ReactElement } from 'react'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlined from '@mui/icons-material/InfoOutlined'

export type AlertTone = 'warning' | 'error' | 'info'

const TONE: Record<AlertTone, { bg: string; fg: string; border: string; icon: ReactElement }> = {
  warning: {
    bg: 'var(--color-warning-bg, #FEF3C7)',
    fg: 'var(--color-warning-fg, #92400E)',
    border: 'var(--color-warning, #B45309)',
    icon: <WarningAmberRounded />,
  },
  error: {
    bg: 'var(--color-error-bg, #FEE2E2)',
    fg: 'var(--color-error-fg, #991B1B)',
    border: 'var(--color-error, #B91C1C)',
    icon: <ErrorOutlineRounded />,
  },
  info: {
    bg: 'var(--color-info-bg, #E0F2FE)',
    fg: '#075985',
    border: 'var(--color-info, #0369A1)',
    icon: <InfoOutlined />,
  },
}

export interface AlertCardProps {
  tone?: AlertTone
  title: ReactNode
  /** Supporting detail line(s). */
  children?: ReactNode
  /** Action buttons/links — e.g. Firmar / Disputar, Confirmar. Rendered below the body. */
  actions?: ReactNode
  /** Override the leading icon. */
  icon?: ReactElement
}

/**
 * Top-of-screen action card that blocks attention until resolved — sign/dispute, pending drop,
 * overbooking warning. Uses functional warning/error semantics (NEVER teal) with a left accent
 * border + tinted fill. Lives at the top of the content hierarchy on transactional screens.
 */
export function AlertCard({ tone = 'warning', title, children, actions, icon }: AlertCardProps) {
  const t = TONE[tone]
  return (
    <Box
      role="alert"
      sx={{
        display: 'flex',
        gap: 1.5,
        p: 2,
        backgroundColor: t.bg,
        borderRadius: 'var(--radius-lg, 16px)',
        border: '1px solid',
        borderColor: t.border,
        borderLeftWidth: 4,
      }}
    >
      <Box sx={{ color: t.border, display: 'flex', pt: '2px', '& svg': { fontSize: 22 } }}>
        {icon ?? t.icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600, color: t.fg }}>{title}</Typography>
        {children && (
          <Typography variant="body2" sx={{ color: t.fg, mt: 0.5, opacity: 0.92 }}>
            {children}
          </Typography>
        )}
        {actions && <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>{actions}</Box>}
      </Box>
    </Box>
  )
}
