import { useId } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Box, Button, CircularProgress, Typography } from '@mui/material'
import { BottomSheet } from './BottomSheet'

export interface FormSheetProps {
  open: boolean
  onClose: () => void
  title: string
  /** Footer primary action label, e.g. 'Guardar' / 'Agregar'. */
  submitLabel: string
  /** Pass RHF's `handleSubmit(onValid)` (or any submit handler) — wired to the internal form. */
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
  /** Mutation in flight: spinner in the button + disables it. */
  busy?: boolean
  /** Extra disable condition independent of busy (e.g. an invalid controlled draft). */
  disabled?: boolean
  /** Rendered in a fixed region ABOVE the footer button (API-level Alert, warnings) —
   *  visible without scrolling the form body. */
  error?: ReactNode
  children: ReactNode
  maxHeight?: string
}

/**
 * The canonical form host: a BottomSheet with a title header, the form as the scroll region,
 * and a fixed footer submit button (spinner when busy). The body is a real <form> and the footer
 * button submits it via the `form` attribute, so Enter-to-submit works with no extra wiring.
 * There is deliberately NO Cancel button — dismissal is the puller / X / backdrop / swipe, the
 * same contract as every other sheet. If a ConfirmSheet must ever open on top of a FormSheet,
 * declare it AFTER the FormSheet in the same parent (equal z-index → DOM order decides).
 */
export function FormSheet({
  open,
  onClose,
  title,
  submitLabel,
  onSubmit,
  busy = false,
  disabled = false,
  error,
  children,
  maxHeight,
}: FormSheetProps) {
  const formId = useId()

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      maxHeight={maxHeight}
      header={
        <Typography variant="h6" sx={{ px: 2, pb: 1 }}>
          {title}
        </Typography>
      }
      footer={
        <>
          {error && <Box sx={{ px: 2, pt: 1 }}>{error}</Box>}
          <Box sx={{ p: 2 }}>
            <Button
              type="submit"
              form={formId}
              fullWidth
              variant="contained"
              disableElevation
              disabled={busy || disabled}
            >
              {busy ? <CircularProgress size={22} color="inherit" /> : submitLabel}
            </Button>
          </Box>
        </>
      }
    >
      {/* pt clears the scroll region's top edge so the first field's floating label (which sits
          ~9px above its box) isn't clipped by the body's `overflow: auto`. */}
      <Box component="form" id={formId} noValidate onSubmit={onSubmit} sx={{ px: 2, pt: 1.5, pb: 2 }}>
        {children}
      </Box>
    </BottomSheet>
  )
}
