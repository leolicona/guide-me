import { useState } from 'react'
import { Avatar, ButtonBase } from '@mui/material'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import { AccountMenu } from './AccountMenu'

const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

interface AccountAvatarChipProps {
  /** When set, the avatar flows as a normal in-bar element (a sibling of, e.g., the Cart
   * button) instead of the fixed top-right overlay — no absolute positioning, no frosted
   * backdrop. Used by pages that own a right-aligned top bar (US-AG31 POS). */
  inline?: boolean
}

// US-UX03 — the mobile account affordance: a small avatar chip. By default it is fixed at the
// top-right of the viewport (safe-area aware, on a solid surface with a hairline border + soft
// overlay shadow so it reads above any content — structure-first, no glass) and opens the account
// bottom sheet. Page titles stay left-aligned, so the fixed variant never collides with them.
// Pages with a right-aligned top bar (POS) render the `inline` variant so the avatar sits as a
// flowed sibling of their actions instead of overlapping.
export function AccountAvatarChip({ inline = false }: AccountAvatarChipProps) {
  const user = useCurrentUser()
  const [open, setOpen] = useState(false)

  return (
    <>
      <ButtonBase
        onClick={() => setOpen(true)}
        aria-label={`Cuenta de ${user.name}`}
        sx={
          inline
            ? { borderRadius: 999, p: 0.5 }
            : {
                position: 'fixed',
                top: 'calc(env(safe-area-inset-top) + 12px)',
                right: 'calc(env(safe-area-inset-right) + 12px)',
                zIndex: (t) => t.zIndex.appBar + 1,
                borderRadius: 999,
                p: 0.5,
                // Solid floating chip — overlays are the one place we use real shadow.
                bgcolor: 'background.paper',
                boxShadow: 'var(--shadow-overlay-sm)',
                border: '1px solid',
                borderColor: 'divider',
              }
        }
      >
        <Avatar sx={{ bgcolor: 'secondary.main', width: 32, height: 32, fontSize: 13 }}>
          {initialsOf(user.name)}
        </Avatar>
      </ButtonBase>

      <AccountMenu variant="sheet" open={open} onClose={() => setOpen(false)} />
    </>
  )
}
