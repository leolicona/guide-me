import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from '@mui/material'
import {
  emailCodeRequestSchema,
  emailCodeSchema,
  type EmailCodeFormData,
  type EmailCodeRequestFormData,
} from '../schemas'
import { useEmailCodeSignIn } from '../hooks/useEmailCodeSignIn'
import { useCountdown } from '../hooks/useCountdown'
import { AuthError, authErrorMessage } from '../authErrors'

export interface EmailCodeFormProps {
  /**
   * Open at the code step for this address. Registration (US3) and an accepted invitation (US4)
   * already sent the code, and the account's address is fixed, so there is no "use another email".
   */
  codeSentTo?: string
  /**
   * Conditional UI (passkey-auth US2): the email field carries `autocomplete="username webauthn"`
   * so the device can offer its llaves de acceso right from it.
   */
  webauthnAutofill?: boolean
  /**
   * The screen's primary action is "Entrar con llave de acceso", so requesting a code steps back to
   * an outlined button: one confident accent per screen (constitution VII).
   */
  secondary?: boolean
  /** Told when the form moves between its email and code steps (`true` = the code step). */
  onCodeStep?: (atCodeStep: boolean) => void
}

// The OTP codes after which the typed code is useless: clear it for the next one.
const CODE_SPENT = new Set(['INVALID_OTP', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'])

/**
 * The código por correo (passkey-auth US1): an email step ("Recibir código") and a 6-digit step.
 * Messages key on Better Auth's codes; a 429 disables the matching button for the seconds Better
 * Auth sends in `X-Retry-After` (FR-012).
 */
export function EmailCodeForm({
  codeSentTo,
  webauthnAutofill = false,
  secondary = false,
  onCodeStep,
}: EmailCodeFormProps) {
  const { sendCode, signIn } = useEmailCodeSignIn()
  // The address the code went to; null while still on the email step.
  const [sentTo, setSentTo] = useState<string | null>(codeSentTo ?? null)
  const [error, setError] = useState<unknown>(null)
  const [resent, setResent] = useState(false)
  const sendWait = useCountdown()
  const signInWait = useCountdown()

  const emailForm = useForm<EmailCodeRequestFormData>({
    resolver: zodResolver(emailCodeRequestSchema),
    defaultValues: { email: '' },
  })
  const codeForm = useForm<EmailCodeFormData>({
    resolver: zodResolver(emailCodeSchema),
    defaultValues: { code: '' },
  })

  const fail = (err: unknown, wait: ReturnType<typeof useCountdown>) => {
    setError(err)
    if (err instanceof AuthError && err.status === 429 && err.retryAfter) wait.start(err.retryAfter)
  }

  const requestCode = emailForm.handleSubmit(({ email }) => {
    setError(null)
    sendCode.mutate(email, {
      // FR-013 — the same confirmation whether or not the address has an account.
      onSuccess: () => {
        setSentTo(email)
        onCodeStep?.(true)
      },
      onError: (err) => fail(err, sendWait),
    })
  })

  const verifyCode = codeForm.handleSubmit(({ code }) => {
    if (!sentTo) return
    setError(null)
    setResent(false)
    signIn.mutate(
      { email: sentTo, code },
      {
        onError: (err) => {
          fail(err, signInWait)
          if (err instanceof AuthError && err.code && CODE_SPENT.has(err.code)) {
            codeForm.reset({ code: '' })
            codeForm.setFocus('code')
          }
        },
      },
    )
  })

  const resendCode = () => {
    if (!sentTo) return
    setError(null)
    setResent(false)
    sendCode.mutate(sentTo, {
      // US1 (scenario 4) — only the newest code works, so the old one is cleared.
      onSuccess: () => {
        setResent(true)
        codeForm.reset({ code: '' })
      },
      onError: (err) => fail(err, sendWait),
    })
  }

  const changeEmail = () => {
    setSentTo(null)
    onCodeStep?.(false)
    setError(null)
    setResent(false)
    codeForm.reset({ code: '' })
  }

  const errorAlert = error ? (
    <Alert severity="error">{authErrorMessage(error)}</Alert>
  ) : null

  if (sentTo === null) {
    const label = 'Recibir código'
    return (
      <Box component="form" noValidate onSubmit={requestCode}>
        <Stack spacing={2}>
          {errorAlert}
          <Controller
            name="email"
            control={emailForm.control}
            render={({ field, fieldState }) => (
              <TextField
                {...field}
                inputRef={field.ref}
                label="Correo electrónico"
                type="email"
                fullWidth
                autoComplete={webauthnAutofill ? 'username webauthn' : 'email'}
                disabled={sendCode.isPending}
                error={!!fieldState.error}
                helperText={fieldState.error?.message}
              />
            )}
          />
          <Button
            type="submit"
            fullWidth
            size="large"
            variant={secondary ? 'outlined' : 'contained'}
            disabled={sendCode.isPending || sendWait.remaining > 0}
            // BUG-022 (as in FormSheet) — the spinner replaces the label, so the name is stated
            // while it shows, and `aria-busy` carries the state.
            aria-label={sendCode.isPending ? label : undefined}
            aria-busy={sendCode.isPending}
          >
            {sendCode.isPending ? (
              <CircularProgress size={22} color="inherit" aria-hidden />
            ) : sendWait.remaining > 0 ? (
              `${label} (${sendWait.remaining} s)`
            ) : (
              label
            )}
          </Button>
        </Stack>
      </Box>
    )
  }

  return (
    <Box component="form" noValidate onSubmit={verifyCode}>
      <Stack spacing={2}>
        <Typography>
          Te enviamos un código de 6 dígitos a{' '}
          <Box component="strong" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {sentTo}
          </Box>
          . Vence en 5 minutos.
        </Typography>
        {resent && <Alert severity="success">Te enviamos un código nuevo.</Alert>}
        {errorAlert}
        <Controller
          name="code"
          control={codeForm.control}
          render={({ field, fieldState }) => (
            <TextField
              {...field}
              inputRef={field.ref}
              label="Código"
              fullWidth
              autoFocus
              // The phone offers the code from the email or SMS straight from the keyboard.
              autoComplete="one-time-code"
              disabled={signIn.isPending}
              error={!!fieldState.error}
              helperText={fieldState.error?.message}
              slotProps={{
                htmlInput: { inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6 },
              }}
            />
          )}
        />
        <Button
          type="submit"
          fullWidth
          size="large"
          variant="contained"
          disabled={signIn.isPending || signInWait.remaining > 0}
          aria-label={signIn.isPending ? 'Entrar' : undefined}
          aria-busy={signIn.isPending}
        >
          {signIn.isPending ? (
            <CircularProgress size={22} color="inherit" aria-hidden />
          ) : signInWait.remaining > 0 ? (
            `Entrar (${signInWait.remaining} s)`
          ) : (
            'Entrar'
          )}
        </Button>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Button
            color="inherit"
            onClick={resendCode}
            disabled={sendCode.isPending || sendWait.remaining > 0}
          >
            {sendWait.remaining > 0
              ? `Reenviar código (${sendWait.remaining} s)`
              : 'Reenviar código'}
          </Button>
          {!codeSentTo && (
            <Button color="inherit" onClick={changeEmail}>
              Usar otro correo
            </Button>
          )}
        </Stack>
      </Stack>
    </Box>
  )
}
