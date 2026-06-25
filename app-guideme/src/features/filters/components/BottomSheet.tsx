import { SwipeableDrawer, Box, IconButton } from '@mui/material'
import type { ReactNode } from 'react'
import CloseRounded from '@mui/icons-material/CloseRounded'

interface BottomSheetProps {
  open: boolean
  onClose: () => void
  /** Fixed region below the puller (e.g. a title or month navigation). */
  header?: ReactNode
  /** Fixed region pinned to the bottom (e.g. an Apply button). */
  footer?: ReactNode
  /** The scrollable body — the only overflow region. */
  children: ReactNode
  maxHeight?: string
}

// The Luminous glass bottom sheet shell (puller + close, glass paper, fixed header/footer with a
// single scroll region between). Shared by the POS day picker and the reports date-range picker.
export function BottomSheet({
  open,
  onClose,
  header,
  footer,
  children,
  maxHeight = '80vh',
}: BottomSheetProps) {
  return (
    <SwipeableDrawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      onOpen={() => {}}
      disableSwipeToOpen
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            maxHeight,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backgroundColor: 'rgba(255,255,255,0.9)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
          },
        },
      }}
    >
      {/* Puller + close — fixed. */}
      <Box sx={{ position: 'relative', pt: 1.5, pb: 0.5, flexShrink: 0 }}>
        <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'divider', mx: 'auto' }} />
        <IconButton
          size="small"
          aria-label="Cerrar"
          onClick={onClose}
          sx={{ position: 'absolute', top: 4, right: 8 }}
        >
          <CloseRounded fontSize="small" />
        </IconButton>
      </Box>

      {header && <Box sx={{ flexShrink: 0 }}>{header}</Box>}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</Box>
      {footer && <Box sx={{ flexShrink: 0 }}>{footer}</Box>}
    </SwipeableDrawer>
  )
}
