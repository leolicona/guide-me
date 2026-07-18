import { Box, useMediaQuery } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import type { ReactNode } from 'react'
import { AccountAvatarChip } from './AccountAvatarChip'

interface TopBarProps {
  /** Page-injected actions (via `useTopBarActions`), rendered to the left of the avatar. */
  actions?: ReactNode
}

/**
 * The fixed top-right cluster: page actions + the account avatar. The container is transparent —
 * each element (cart, avatar) carries its own floating circular surface (see `floatingControlSx`)
 * so they read as two distinct controls, not one fused chip. Owned by AppLayout and rendered once
 * for the whole authenticated app, so the avatar element is never recreated on navigation (no jump).
 *
 * The avatar shows on mobile only — on desktop it lives in the rail — while actions show on all
 * breakpoints. When there is nothing to show (desktop + no actions) the bar renders nothing.
 */
export function TopBar({ actions }: TopBarProps) {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const showAvatar = !isDesktop

  if (!actions && !showAvatar) return null

  return (
    <Box
      sx={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top) + 12px)',
        right: 'calc(env(safe-area-inset-right) + 12px)',
        zIndex: (t) => t.zIndex.appBar + 1,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
      }}
    >
      {actions}
      {showAvatar && <AccountAvatarChip />}
    </Box>
  )
}
