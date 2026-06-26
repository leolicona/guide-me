import { alpha } from '@mui/material/styles'
import type { SxProps, Theme } from '@mui/material/styles'

// Shared filter primitives, lifted out of PosCatalogPage so the POS catalog and the reports
// controls render the same chips/pills from one source. Colors are theme-driven (teal accent).

// A tall rounded date pill: filled teal when active (the one confident accent on the strip),
// hairline-bordered surface otherwise.
export const datePillSx = (active: boolean): SxProps<Theme> => ({
  flexShrink: 0,
  height: 48,
  px: 2,
  gap: 1,
  borderRadius: '0.75rem',
  fontSize: 13,
  fontWeight: active ? 600 : 500,
  letterSpacing: '0.01em',
  whiteSpace: 'nowrap',
  transition: 'background-color 160ms ease, color 160ms ease',
  color: active ? 'primary.contrastText' : 'text.secondary',
  bgcolor: active ? 'primary.main' : 'background.paper',
  border: active ? '1px solid transparent' : '1px solid',
  borderColor: active ? 'transparent' : 'divider',
  '&:hover': {
    bgcolor: active ? 'primary.main' : 'action.hover',
  },
})

// A short pill-shaped filter chip: a soft teal tint when active, hairline surface otherwise
// (rounded-full, low-saturation accent).
export const chipPillSx = (active: boolean): SxProps<Theme> => ({
  flexShrink: 0,
  height: 36,
  px: 2,
  borderRadius: 999,
  fontSize: 13,
  fontWeight: active ? 600 : 500,
  whiteSpace: 'nowrap',
  transition: 'background-color 160ms ease, color 160ms ease',
  color: active ? 'primary.main' : 'text.secondary',
  bgcolor: (t: Theme) =>
    active ? alpha(t.palette.primary.main, 0.1) : t.palette.background.paper,
  border: active ? '1px solid transparent' : '1px solid',
  borderColor: active ? 'transparent' : 'divider',
  '&:hover': {
    bgcolor: (t: Theme) =>
      active ? alpha(t.palette.primary.main, 0.16) : t.palette.action.hover,
  },
})

// A horizontally scrollable strip that bleeds to the screen edge on mobile (so the first/last
// pill can sit flush) and hides its scrollbar.
export const filterStripSx: SxProps<Theme> = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  overflowX: 'auto',
  py: 0.5,
  mx: { xs: -2, md: 0 },
  px: { xs: 2, md: 0 },
  scrollbarWidth: 'none',
  '&::-webkit-scrollbar': { display: 'none' },
}
