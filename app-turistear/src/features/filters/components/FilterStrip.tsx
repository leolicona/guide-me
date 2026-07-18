import { Box } from '@mui/material'
import type { ReactNode } from 'react'
import type { SxProps, Theme } from '@mui/material/styles'
import { filterStripSx } from '../filterStyles'

// A horizontally scrollable row of filter pills (edge-bleeds on mobile, hides its scrollbar).
export function FilterStrip({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) {
  return (
    <Box sx={[filterStripSx, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}>{children}</Box>
  )
}
