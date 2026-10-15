import { useEffect } from 'react'
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material'
import KeyRounded from '@mui/icons-material/KeyRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import { BottomSheet } from '../../../components'
import { useAddPasskey } from '../hooks/useAddPasskey'
import { useSignInAgain } from '../hooks/useSignInAgain'
import { AuthError, authErrorMessage } from '../authErrors'

export interface PasskeyOfferProps {
  open: boolean
  onClose: () => void
  /**
   * `offer` — after an email-code sign-in (FR-007), declined with "Ahora no".
   * `add` — "Agregar llave de acceso" on Seguridad (US5): the same flow, asked for.
   */
  mode?: 'offer' | 'add'
}

const COPY = {
  offer: {
    title: 'Entra sin esperar un código',
    body: 'Crea una llave de acceso y la próxima vez entra con tu huella, tu cara o el PIN de este dispositivo.',
    decline: 'Ahora no',
  },
  add: {
    title: 'Agregar llave de acceso',
    body: 'Guárdala en este dispositivo o en una llave de seguridad. Entrarás con tu huella, tu cara o tu PIN.',
    decline: 'Cancelar',
  },
} as const

const CREATE = 'Crear llave de acceso'

/**
 * The offer to create a llave de acceso (passkey-auth US2, FR-007, SC-008). Never forced: "Ahora no"
 * closes it, and the email code keeps working. Closing the device's prompt leaves the offer as it
 * was (scenario 6). A session older than a day gets `SESSION_NOT_FRESH` from Better Auth, and the
 * only way on is to sign in again (scenario 9).
 */
export function PasskeyOffer({ open, onClose, mode = 'offer' }: PasskeyOfferProps) {
  const add = useAddPasskey()
  const signInAgain = useSignInAgain()
  const { reset } = add

  // Each opening starts from the question, not from the last outcome.
  useEffect(() => {
    if (open) reset()
  }, [open, reset])

  const created = add.data === true
  const notFresh = add.error instanceof AuthError && add.error.code === 'SESSION_NOT_FRESH'
  const copy = COPY[mode]
  const title = created ? 'Llave de acceso creada' : copy.title

  const primary = created ? (
    <Button fullWidth variant="contained" onClick={onClose}>
      Listo
    </Button>
  ) : notFresh ? (
    <Button
      fullWidth
      variant="contained"
      disabled={signInAgain.isPending}
      onClick={() => signInAgain.mutate()}
    >
      Volver a entrar
    </Button>
  ) : (
    <Button
      fullWidth
      variant="contained"
      disabled={add.isPending}
      onClick={() => add.mutate()}
      // BUG-022 (as in FormSheet) — the spinner replaces the label, so the name is stated while it
      // shows, and `aria-busy` carries the state.
      aria-label={add.isPending ? CREATE : undefined}
      aria-busy={add.isPending}
    >
      {add.isPending ? <CircularProgress size={22} color="inherit" aria-hidden /> : CREATE}
    </Button>
  )

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      header={
        <Typography variant="h6" component="h2" sx={{ px: 2, pb: 1 }}>
          {title}
        </Typography>
      }
      footer={
        <Stack spacing={1} sx={{ p: 2 }}>
          {primary}
          {!created && (
            <Button fullWidth color="inherit" disabled={add.isPending} onClick={onClose}>
              {copy.decline}
            </Button>
          )}
        </Stack>
      }
    >
      <Box sx={{ px: 2, pb: 1 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          {created ? (
            <CheckCircleRounded color="success" aria-hidden />
          ) : (
            <KeyRounded sx={{ color: 'text.secondary' }} aria-hidden />
          )}
          <Typography variant="body2" color="textSecondary">
            {created
              ? 'Listo. La próxima vez toca «Entrar con llave de acceso».'
              : copy.body}
          </Typography>
        </Stack>
        {add.error && (
          <Alert severity={notFresh ? 'warning' : 'error'} sx={{ mt: 2 }}>
            {authErrorMessage(add.error)}
          </Alert>
        )}
      </Box>
    </BottomSheet>
  )
}
