import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'

export interface ListPageHeaderProps {
  /** The page title, rendered as the page's single h1. */
  title: string
  /** Primary action (e.g. a "create" Button). On mobile it drops to its own full-width row
   *  below the title — clear of the fixed top-right account avatar (US-UX03) — and sits inline
   *  on the right from `md` up, where the avatar lives in the rail instead. */
  action?: ReactNode
}

/**
 * The standard admin list-page header (Elegant Field Minimalism): the header row is reserved for
 * the page title and the shell's account control, never a competing action. A primary action, if
 * given, is placed so it never collides with the fixed mobile avatar — its own row on mobile,
 * inline at `md+`. Shared by the Catálogo / Agentes / Afiliados list pages so they read identically.
 */
export function ListPageHeader({ title, action }: ListPageHeaderProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', md: 'row' },
        justifyContent: 'space-between',
        alignItems: { xs: 'stretch', md: 'center' },
        gap: 2,
        mb: 3,
      }}
    >
      {/* Reserve the fixed avatar's corner on mobile so a longer title wraps before reaching it. */}
      <Typography variant="h4" component="h1" sx={{ pr: { xs: 7, md: 0 } }}>
        {title}
      </Typography>
      {action && (
        <Box
          sx={{
            flexShrink: 0,
            width: { xs: '100%', md: 'auto' },
            // Let whatever action is passed (a Button, usually) fill the row on mobile.
            '& > *': { width: { xs: '100%', md: 'auto' } },
          }}
        >
          {action}
        </Box>
      )}
    </Box>
  )
}
