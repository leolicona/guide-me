import { useState } from 'react'
import { Avatar, ButtonBase } from '@mui/material'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import { AccountMenu } from './AccountMenu'
import { floatingControlSx } from './topBarStyles'

const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

// US-UX03 — the mobile account affordance: the avatar button that opens the account sheet.
// Positioning is owned by the parent (TopBar); the button itself is a self-contained floating
// circle (floatingControlSx) so it reads as its own control beside any sibling action (e.g. cart).
export function AccountAvatarChip() {
  const user = useCurrentUser()
  const [open, setOpen] = useState(false)

  return (
    <>
      <ButtonBase
        onClick={() => setOpen(true)}
        aria-label={`Cuenta de ${user.name}`}
        sx={floatingControlSx}
      >
        <Avatar sx={{ bgcolor: 'secondary.main', width: 36, height: 36, fontSize: 14 }}>
          {initialsOf(user.name)}
        </Avatar>
      </ButtonBase>

      <AccountMenu variant="sheet" open={open} onClose={() => setOpen(false)} />
    </>
  )
}
