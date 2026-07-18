import { ButtonBase } from '@mui/material'
import type { ReactNode } from 'react'
import { datePillSx, chipPillSx } from '../filterStyles'

interface FilterPillProps {
  /** `date` = tall Indigo-fill pill (date strip); `chip` = short pill-shaped filter chip. */
  variant?: 'date' | 'chip'
  active?: boolean
  onClick?: () => void
  /** Leading glyph (e.g. a calendar icon on the date-range pill). */
  startIcon?: ReactNode
  'aria-label'?: string
  children?: ReactNode
}

// One filter pill — the shared chip used by the POS catalog and the reports controls. Renders a
// real <button> via ButtonBase (focus ring, keyboard, ripple) styled by variant.
export function FilterPill({
  variant = 'chip',
  active = false,
  onClick,
  startIcon,
  children,
  ...rest
}: FilterPillProps) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-label={rest['aria-label']}
      aria-pressed={active}
      sx={variant === 'date' ? datePillSx(active) : chipPillSx(active)}
    >
      {startIcon}
      {children}
    </ButtonBase>
  )
}
