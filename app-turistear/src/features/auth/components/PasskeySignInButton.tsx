import { useEffect, useRef } from 'react'
import { Alert, Button, CircularProgress, Stack } from '@mui/material'
import KeyRounded from '@mui/icons-material/KeyRounded'
import { usePasskeySignIn } from '../hooks/usePasskeySignIn'
import { authErrorMessage } from '../authErrors'
import { passkeysSupported } from '../webauthn'

export interface PasskeySignInButtonProps {
  /**
   * Also listen for conditional UI: the device offers its llaves de acceso from the email field's
   * autofill (the field must carry `autocomplete="username webauthn"`). Set only when
   * `PublicKeyCredential.isConditionalMediationAvailable()` resolved true.
   */
  autoFill?: boolean
}

const LABEL = 'Entrar con llave de acceso'

/**
 * "Entrar con llave de acceso" (passkey-auth US2, FR-001): the screen's primary action, two taps on
 * a dock at noon — no email, no code. Hidden where the browser has no WebAuthn.
 *
 * Closing the device's prompt brings the person back here with no message (scenario 6). A llave the
 * server no longer knows says so and points to the email code below (scenario 5).
 */
export function PasskeySignInButton({ autoFill = false }: PasskeySignInButtonProps) {
  const prompt = usePasskeySignIn()
  const conditional = usePasskeySignIn()
  const startConditional = conditional.mutate
  const conditionalStarted = useRef(false)

  useEffect(() => {
    if (!autoFill || conditionalStarted.current) return
    conditionalStarted.current = true
    // Pending until the person picks a llave from the autofill. Tapping the button starts a new
    // ceremony, which aborts this one; the abort comes back as a cancel and stays silent.
    startConditional({ autoFill: true })
  }, [autoFill, startConditional])

  if (!passkeysSupported()) return null

  const error = prompt.error ?? conditional.error

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{authErrorMessage(error)}</Alert>}
      <Button
        fullWidth
        size="large"
        variant="contained"
        startIcon={prompt.isPending ? undefined : <KeyRounded />}
        disabled={prompt.isPending}
        onClick={() => {
          conditional.reset()
          prompt.mutate({ autoFill: false })
        }}
        // BUG-022 (as in FormSheet) — the spinner replaces the label, so the name is stated while it
        // shows, and `aria-busy` carries the state.
        aria-label={prompt.isPending ? LABEL : undefined}
        aria-busy={prompt.isPending}
      >
        {prompt.isPending ? <CircularProgress size={22} color="inherit" aria-hidden /> : LABEL}
      </Button>
    </Stack>
  )
}
