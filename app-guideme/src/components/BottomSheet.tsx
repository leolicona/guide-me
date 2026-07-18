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
  /** Max paper width from `sm` up (mobile is always full-width). The sheet stays docked to the
   *  bottom edge, centered — a full-viewport-wide sheet reads wrong on desktop. */
  paperMaxWidth?: number
}

/**
 * The canonical overlay primitive (Elegant Field Minimalism): puller + close, a solid white
 * sheet that casts a real upward shadow, fixed header/footer with a single scroll region between.
 * One of the few places the system uses elevation — resting surfaces are structure-first.
 * Shared by the POS day picker, the reports date-range picker, and feature config sheets.
 */
export function BottomSheet({
  open,
  onClose,
  header,
  footer,
  children,
  maxHeight = '90vh',
  paperMaxWidth = 640,
}: BottomSheetProps) {
  return (
    <SwipeableDrawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      onOpen={() => {}}
      disableSwipeToOpen
      // A temporary Drawer defaults to the `drawer` z-index (1200), which sits BELOW a Dialog
      // (`modal`, 1300). The BottomSheet is the canonical top-most config overlay and can be opened
      // from inside a wizard Dialog (e.g. the lodging UnitDraftSheet), so it must outrank the modal
      // layer — otherwise it renders behind the dialog and looks like nothing happened.
      sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: 'var(--radius-xl, 20px)',
            borderTopRightRadius: 'var(--radius-xl, 20px)',
            width: '100%',
            maxWidth: { xs: '100%', sm: paperMaxWidth },
            mx: 'auto',
            maxHeight,
            // Keep the footer action above the home-indicator / gesture bar on notched phones
            // (resolves to 0 elsewhere) — the sheet is docked to the physical bottom edge.
            pb: 'env(safe-area-inset-bottom)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backgroundColor: '#FFFFFF',
            // Real shadow — overlays earn elevation (cast upward).
            boxShadow: 'var(--shadow-sheet, 0 -8px 30px rgba(15,23,42,0.12))',
          },
        },
      }}
    >
      {/* Puller + close — fixed. */}
      <Box sx={{ position: 'relative', pt: 1.5, pb: 0.5, flexShrink: 0 }}>
        <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'divider', mx: 'auto' }} />
        <IconButton
          aria-label="Cerrar"
          onClick={onClose}
          // A quiet control (text.secondary): a 44px touch target (p:1.5 + 20px glyph) that
          // meets the field-use minimum, with its glyph aligned to the 16px content gutter the
          // header/body/footer share (top:4/right:4 on the 4px scale).
          sx={{ position: 'absolute', top: 4, right: 4, p: 1.5, color: 'text.secondary' }}
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
