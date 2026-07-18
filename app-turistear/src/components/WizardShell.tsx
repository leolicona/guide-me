import type { ReactNode } from 'react'
import {
  Dialog,
  Box,
  Typography,
  IconButton,
  LinearProgress,
  Button,
  Stack,
  Fade,
  Divider,
  CircularProgress,
} from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import CheckRounded from '@mui/icons-material/CheckRounded'

export interface WizardShellProps {
  open: boolean
  /** Close (X) handler — the parent owns any discard-confirm logic. */
  onClose: () => void
  /** Modal title, e.g. "Nuevo servicio" / "Nuevo afiliado". */
  title: string
  /** 1-based current step and the total. */
  step: number
  totalSteps: number
  /** Short title for the current step, shown beside "PASO n DE N". */
  stepTitle?: ReactNode
  onBack: () => void
  onNext: () => void
  /** Final-step submit handler (called when `isLastStep`). */
  onFinish: () => void
  isLastStep: boolean
  /** Footer labels — defaults: "Siguiente" / "Finalizar". */
  nextLabel?: string
  finishLabel?: string
  /** Gate the Siguiente button (e.g. step validation). Default true (enabled). When a wizard
   *  validates on click instead, leave this true and validate inside `onNext`. */
  canAdvance?: boolean
  /** Gate the Finalizar button. Default true (enabled). */
  canFinish?: boolean
  /** Disables the footer + close and shows a spinner on the finish button. */
  busy?: boolean
  /** Optional error region rendered above the footer (e.g. an <Alert>). */
  error?: ReactNode
  /** The current step's body. */
  children: ReactNode
}

/** The host-agnostic wizard chrome props — everything in `WizardShellProps` except `open`,
 * which only makes sense for the Dialog host. */
export type WizardChromeProps = Omit<WizardShellProps, 'open'>

/**
 * The shared multi-step chrome (Elegant Field Minimalism): a fixed header (title · close X ·
 * "PASO n DE N" + step title · teal progress bar), a single scrollable body that fades on step
 * change, and a fixed footer (Anterior / Siguiente → Finalizar; Anterior disabled on step 1).
 * Host-agnostic: `WizardShell` mounts it inside a Dialog, `WizardPage` inside a full page.
 * Expects a flex-column host with a fixed height — the body takes `flex: 1` and scrolls.
 */
export function WizardChrome({
  onClose,
  title,
  step,
  totalSteps,
  stepTitle,
  onBack,
  onNext,
  onFinish,
  isLastStep,
  nextLabel = 'Siguiente',
  finishLabel = 'Finalizar',
  canAdvance = true,
  canFinish = true,
  busy = false,
  error,
  children,
}: WizardChromeProps) {
  return (
    <>
      {/* Fixed header — title, close, step indicator, progress (US-A38/A54) */}
      <Box sx={{ px: 3, pt: 2.5, pb: 2, flexShrink: 0 }}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6">{title}</Typography>
          <IconButton edge="end" onClick={onClose} disabled={busy} aria-label="Cerrar">
            <CloseRounded />
          </IconButton>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mt: 0.25 }}>
          <Typography variant="overline" color="secondary" sx={{ fontWeight: 700, letterSpacing: 1 }}>
            Paso {step} de {totalSteps}
          </Typography>
          {stepTitle && (
            <Typography variant="body2" color="text.secondary">
              · {stepTitle}
            </Typography>
          )}
        </Stack>
        <LinearProgress
          variant="determinate"
          color="secondary"
          value={(step / totalSteps) * 100}
          sx={{ mt: 1.5, height: 6, borderRadius: 3, bgcolor: 'action.hover' }}
        />
      </Box>

      <Divider />

      {/* Scrollable body — fades on step change */}
      <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 3 }}>
        <Fade in key={step} timeout={250}>
          <Box>{children}</Box>
        </Fade>
      </Box>

      {error && (
        <Box sx={{ mx: 3, mb: 1 }}>{error}</Box>
      )}

      <Divider />

      {/* Fixed footer (US-A38/A54) — Anterior disabled on step 1 */}
      <Box sx={{ px: 3, py: 2, flexShrink: 0 }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Button
            onClick={onBack}
            disabled={step === 1 || busy}
            startIcon={<ArrowBackRounded />}
            color="inherit"
          >
            Anterior
          </Button>
          {isLastStep ? (
            <Button
              onClick={onFinish}
              variant="contained"
              color="secondary"
              disabled={busy || !canFinish}
              startIcon={busy ? <CircularProgress size={18} color="inherit" /> : <CheckRounded />}
            >
              {finishLabel}
            </Button>
          ) : (
            <Button
              onClick={onNext}
              variant="contained"
              color="secondary"
              disabled={busy || !canAdvance}
            >
              {nextLabel}
            </Button>
          )}
        </Stack>
      </Box>
    </>
  )
}

/**
 * The multi-step modal host (Elegant Field Minimalism): `WizardChrome` inside a Dialog —
 * full-screen on mobile (90vh, rounded top edges), centered on desktop. Used by the Affiliate
 * Setup wizard (US-A54–A57); the Service Creation wizard now lives on a page (`WizardPage`).
 */
export function WizardShell({ open, onClose, ...chrome }: WizardShellProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      slotProps={{
        paper: {
          sx: {
            m: { xs: 0, sm: 2 },
            position: { xs: 'fixed', sm: 'relative' },
            bottom: { xs: 0, sm: 'auto' },
            left: { xs: 0, sm: 'auto' },
            right: { xs: 0, sm: 'auto' },
            width: { xs: '100%', sm: '100%' },
            maxWidth: { sm: 600 },
            height: { xs: '90vh', sm: 'auto' },
            maxHeight: { xs: '90vh', sm: '88vh' },
            borderRadius: { xs: 'var(--radius-xl, 20px) var(--radius-xl, 20px) 0 0', sm: 'var(--radius-lg, 16px)' },
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        },
      }}
    >
      <WizardChrome onClose={onClose} {...chrome} />
    </Dialog>
  )
}
