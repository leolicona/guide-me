import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Box, Typography, CircularProgress, Fade, Stack, Button } from '@mui/material'
import LockRounded from '@mui/icons-material/LockRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import { PinPad } from '../features/operators/components/PinPad'
import { resolveOperatorAccess, setOperatorPin, operatorLogin } from '../services/operatorsService'
import { ServiceError } from '../services/authService'
import { queryClient } from '../config/queryClient'
import { ROUTES } from '../config/routes'

// US-OP01/OP02 — the operator's saved WhatsApp link lands here. First open ⇒ set + confirm a PIN;
// returning ⇒ enter the PIN to unlock a 24h shift. On success the server sets the shift cookie; we
// refresh the session and drop the operator straight into the POS.

type SetStep = 'enter' | 'confirm'

export default function OperatorAccessPage() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()

  const { data: access, isLoading, isError } = useQuery({
    queryKey: ['operator-access', token],
    queryFn: () => resolveOperatorAccess(token),
    enabled: !!token,
    retry: false,
  })

  const [pin, setPin] = useState('')
  const [firstPin, setFirstPin] = useState('') // first entry during set-PIN
  const [step, setStep] = useState<SetStep>('enter')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockedOut, setLockedOut] = useState(false) // set on a 423 during this session

  // Locked either from the server's resolve (already at the attempt cap) or a 423 we just hit.
  const locked = lockedOut || !!access?.locked

  const enterShift = async () => {
    await queryClient.invalidateQueries({ queryKey: ['me'] })
    navigate(ROUTES.POS, { replace: true })
  }

  // Auto-submit when the PIN reaches 4 digits.
  useEffect(() => {
    if (pin.length !== 4 || busy || locked || !access) return

    const run = async () => {
      setBusy(true)
      setError(null)
      try {
        if (!access.pin_set) {
          // First-run set + confirm.
          if (step === 'enter') {
            setFirstPin(pin)
            setPin('')
            setStep('confirm')
            setBusy(false)
            return
          }
          if (pin !== firstPin) {
            setError('Los PIN no coinciden. Inténtalo de nuevo.')
            setFirstPin('')
            setStep('enter')
            setPin('')
            setBusy(false)
            return
          }
          await setOperatorPin(token, firstPin, pin)
          await enterShift()
          return
        }
        // Returning: unlock.
        await operatorLogin(token, pin)
        await enterShift()
      } catch (e) {
        const err = e as ServiceError
        if (err.status === 423) {
          setLockedOut(true)
        } else {
          setError(err.status === 401 ? 'PIN incorrecto.' : 'No se pudo continuar. Inténtalo de nuevo.')
        }
        setPin('')
        setBusy(false)
      }
    }
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin])

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
        bgcolor: 'background.default',
      }}
    >
      {isLoading && <CircularProgress />}

      {isError && (
        <Stack spacing={2} sx={{ alignItems: 'center', textAlign: 'center', maxWidth: 360 }}>
          <LockRounded sx={{ fontSize: 48, color: 'text.disabled' }} />
          <Typography variant="h6">Enlace no válido</Typography>
          <Typography variant="body2" color="text.secondary">
            Este enlace de acceso ya no funciona. Pídele a tu gerente que te reenvíe uno nuevo.
          </Typography>
        </Stack>
      )}

      {access && (
        <Fade in timeout={300}>
          <Stack spacing={4} sx={{ alignItems: 'center', width: '100%', maxWidth: 360 }}>
            <Stack spacing={0.5} sx={{ alignItems: 'center', textAlign: 'center' }}>
              <StorefrontRounded sx={{ fontSize: 40, color: 'secondary.main' }} />
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {access.hotel_name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Hola, {access.name}
              </Typography>
            </Stack>

            {locked ? (
              <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center' }}>
                <LockRounded sx={{ fontSize: 40, color: 'error.main' }} />
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  Acceso bloqueado
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Demasiados intentos. Pídele a tu gerente que restablezca tu PIN.
                </Typography>
              </Stack>
            ) : (
              <>
                <Typography variant="body1" sx={{ fontWeight: 600, textAlign: 'center' }}>
                  {!access.pin_set
                    ? step === 'enter'
                      ? 'Crea tu PIN de 4 dígitos'
                      : 'Confirma tu PIN'
                    : 'Ingresa tu PIN'}
                </Typography>

                <PinPad value={pin} onChange={setPin} disabled={busy} error={!!error} />

                <Box sx={{ minHeight: 24 }}>
                  {busy ? (
                    <CircularProgress size={20} />
                  ) : error ? (
                    <Typography variant="body2" color="error.main">
                      {error}
                    </Typography>
                  ) : null}
                </Box>
              </>
            )}
          </Stack>
        </Fade>
      )}

      {access && !locked && !access.pin_set && step === 'confirm' && !busy && (
        <Button
          variant="text"
          size="small"
          sx={{ mt: 2 }}
          onClick={() => {
            setStep('enter')
            setFirstPin('')
            setPin('')
            setError(null)
          }}
        >
          Empezar de nuevo
        </Button>
      )}
    </Box>
  )
}
