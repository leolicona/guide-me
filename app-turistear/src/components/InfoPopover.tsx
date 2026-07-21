import { useState } from 'react'
import type { ReactNode, MouseEvent } from 'react'
import { IconButton, Popover, Box } from '@mui/material'
import type { IconButtonProps } from '@mui/material'
import InfoOutlinedRounded from '@mui/icons-material/InfoOutlined'

export interface InfoPopoverProps {
  /** The help content — kept behind an intentional tap so it never clutters the scan. */
  children: ReactNode
  /** Accessible name for the trigger (e.g. "Sobre el método de pago"). */
  label: string
  /** Trigger size. Defaults to small — it rides beside a title or field label. */
  size?: IconButtonProps['size']
}

/**
 * A restrained help affordance for the field-agent UI: a neutral `i` button that reveals a short
 * explanation only on an intentional click/tap (touch-friendly — no hover dependency). Use it to
 * pull rarely-needed prose OUT of the always-on layout so the happy path stays scannable, while
 * the "why" stays one tap away. See DESIGN_BRIEF — legible in sunlight · reach & repetition.
 */
export function InfoPopover({ children, label, size = 'small' }: InfoPopoverProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null)
  const open = Boolean(anchorEl)

  const handleOpen = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    setAnchorEl(e.currentTarget)
  }
  const handleClose = () => setAnchorEl(null)

  return (
    <>
      <IconButton
        size={size}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={handleOpen}
        sx={{ color: 'text.secondary', p: 0.75 }}
      >
        <InfoOutlinedRounded fontSize="small" />
      </IconButton>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              maxWidth: 300,
              p: 2,
              borderRadius: 'var(--radius-md, 12px)',
              // Real elevation — a popover is a true overlay (one of the few places the system
              // spends shadow). Mirrors the BottomSheet's overlay treatment.
              boxShadow: 'var(--shadow-overlay-md, 0 12px 32px rgba(15,23,42,0.14))',
            },
          },
        }}
      >
        <Box sx={{ fontSize: 14, lineHeight: 1.55, color: 'text.secondary' }}>{children}</Box>
      </Popover>
    </>
  )
}
