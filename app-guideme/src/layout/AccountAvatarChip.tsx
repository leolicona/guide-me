import { useState } from 'react'
import { Avatar, ButtonBase } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import { AccountMenu } from './AccountMenu'

const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

// US-UX03 — the mobile account affordance: a small avatar chip fixed at the top-right of the
// viewport (safe-area aware, with a subtle frosted backdrop so it reads above any content). It
// opens the account bottom sheet. Page titles stay left-aligned, so this never collides with
// them — it is the only fixed overlay.
export function AccountAvatarChip() {
  const user = useCurrentUser()
  const [open, setOpen] = useState(false)

  return (
    <>
      <ButtonBase
        onClick={() => setOpen(true)}
        aria-label={`Cuenta de ${user.name}`}
        sx={{
          position: 'fixed',
          top: 'calc(env(safe-area-inset-top) + 12px)',
          right: 'calc(env(safe-area-inset-right) + 12px)',
          zIndex: (t) => t.zIndex.appBar + 1,
          borderRadius: 999,
          p: 0.5,
          bgcolor: (t) => alpha(t.palette.background.paper, 0.7),
          backdropFilter: 'blur(8px)',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Avatar sx={{ bgcolor: 'secondary.main', width: 32, height: 32, fontSize: 13 }}>
          {initialsOf(user.name)}
        </Avatar>
      </ButtonBase>

      <AccountMenu variant="sheet" open={open} onClose={() => setOpen(false)} />
    </>
  )
}
