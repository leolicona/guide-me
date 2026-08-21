import { Box, ButtonBase } from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import type { ReactNode } from 'react'
import { filterChipSx } from '../filterStyles'

interface ClearableFilterChipProps {
  /** Lit (teal-tinted) when the filter carries a selection. */
  active: boolean
  /** Opens the filter's picker — the strip's grammar: an icon here means "opens a sheet". */
  onClick: () => void
  /** Resets THIS filter. Omit (or pass with `active` false) and no ✕ renders. */
  onClear?: () => void
  /** Names what the ✕ removes, e.g. "Quitar la fecha" — never a bare "Limpiar" for SRs. */
  clearLabel?: string
  startIcon?: ReactNode
  'aria-label'?: string
  children?: ReactNode
}

// A filter chip that carries its own reset. The ✕ is a SIBLING <button>, never nested inside the
// body button — the same nesting/a11y fault the ⚡ Express control avoids on the catalog card. The
// pill's styling moves to a non-interactive container so both children can own real hit areas at
// the full 48px height (brief: reach & repetition).
//
// Per-chip reset rather than one strip-wide "Limpiar": each control clears exactly what it set (no
// ambiguity of scope), it costs no width on a strip that already scrolls on mobile, and it keeps
// working unchanged when a third filter joins the strip.
export function ClearableFilterChip({
  active,
  onClick,
  onClear,
  clearLabel,
  startIcon,
  children,
  ...rest
}: ClearableFilterChipProps) {
  // The ✕ only earns its place when there is a selection to remove.
  const clearable = active && Boolean(onClear)

  return (
    <Box sx={[filterChipSx(active), { px: 0, overflow: 'hidden' }]}>
      <ButtonBase
        onClick={onClick}
        aria-label={rest['aria-label']}
        aria-pressed={active}
        sx={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          pl: 2,
          pr: clearable ? 1 : 2,
          font: 'inherit',
          color: 'inherit',
        }}
      >
        {startIcon}
        {children}
      </ButtonBase>

      {clearable && (
        <ButtonBase
          onClick={onClear}
          aria-label={clearLabel}
          sx={{
            height: '100%',
            pl: 0.5,
            pr: 1.5,
            display: 'flex',
            alignItems: 'center',
            color: 'inherit',
            '&:hover': { opacity: 0.7 },
          }}
        >
          <CloseRounded sx={{ fontSize: 18 }} />
        </ButtonBase>
      )}
    </Box>
  )
}
