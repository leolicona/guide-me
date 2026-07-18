import type { ReactNode } from 'react'
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material'
import { BottomSheet } from './BottomSheet'

export interface ConfirmSheetProps {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  confirmLabel: string
  /** Destructive by default — most confirms are deactivate/delete/discard. */
  confirmColor?: 'error' | 'primary'
  onConfirm: () => void
  busy?: boolean
  /** Error/notice region under the description (e.g. the 409 "has folios" Alert). */
  error?: ReactNode
  /** Terminal-error mode: hide the confirm button entirely, leaving only cancel/close. */
  hideConfirm?: boolean
  cancelLabel?: string
}

/**
 * The canonical confirmation overlay: a compact BottomSheet with a question title, a short
 * consequence description, and a stacked confirm-over-cancel footer. Replaces the small
 * centered Dialogs so the app has exactly one overlay pattern. If it must ever open on top of
 * a FormSheet, declare it AFTER the FormSheet in the same parent (equal z-index → DOM order).
 */
export function ConfirmSheet({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  confirmColor = 'error',
  onConfirm,
  busy = false,
  error,
  hideConfirm = false,
  cancelLabel = 'Cancelar',
}: ConfirmSheetProps) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      header={
        <Typography variant="h6" sx={{ px: 2, pb: 1 }}>
          {title}
        </Typography>
      }
      footer={
        <Stack spacing={1} sx={{ p: 2 }}>
          {!hideConfirm && (
            <Button
              fullWidth
              variant="contained"
              disableElevation
              color={confirmColor}
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? <CircularProgress size={22} color="inherit" /> : confirmLabel}
            </Button>
          )}
          <Button fullWidth color="inherit" disabled={busy} onClick={onClose}>
            {cancelLabel}
          </Button>
        </Stack>
      }
    >
      <Box sx={{ px: 2, pb: 1 }}>
        {description && (
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        )}
        {error && <Box sx={{ mt: description ? 1.5 : 0 }}>{error}</Box>}
      </Box>
    </BottomSheet>
  )
}
