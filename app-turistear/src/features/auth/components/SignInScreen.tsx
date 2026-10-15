import { useEffect, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import { Alert, Box, Link, Stack, Typography } from '@mui/material'
import { ROUTES } from '../../../config/routes'
import { conditionalMediationAvailable, passkeysSupported } from '../webauthn'
import { EmailCodeForm } from './EmailCodeForm'
import { PasskeySignInButton } from './PasskeySignInButton'

/**
 * The sign-in screen (passkey-auth D14): "Entrar con llave de acceso" first, then the código por
 * correo, which always works. Where the browser has no WebAuthn the code is the only way in, and
 * its button takes the primary role.
 */
export function SignInScreen() {
  const [searchParams] = useSearchParams()
  // Set by the global interceptor when a suspended account is bounced (US-A08).
  const suspended = searchParams.get('reason') === 'suspended'
  const supported = passkeysSupported()
  const [autoFill, setAutoFill] = useState(false)
  // Once a code is on its way, "Entrar" with it is the one action left — one confident accent
  // (constitution VII), so the llave de acceso steps aside until "Usar otro correo".
  const [atCodeStep, setAtCodeStep] = useState(false)
  const offerPasskey = supported && !atCodeStep

  useEffect(() => {
    let live = true
    void conditionalMediationAvailable().then((available) => {
      if (live) setAutoFill(available)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <Stack spacing={3}>
      {suspended && (
        <Alert severity="error">Tu cuenta ha sido suspendida. Contacta a tu administrador.</Alert>
      )}

      {offerPasskey && (
        <>
          <PasskeySignInButton autoFill={autoFill} />
          <Typography variant="body2" color="textSecondary" sx={{ textAlign: 'center' }}>
            o recibe un código por correo
          </Typography>
        </>
      )}

      <EmailCodeForm
        webauthnAutofill={autoFill}
        secondary={supported}
        onCodeStep={setAtCodeStep}
      />

      <Box sx={{ textAlign: 'center' }}>
        <Link component={RouterLink} to={ROUTES.REGISTER} variant="body2" underline="hover">
          ¿No tienes cuenta? Regístrate
        </Link>
      </Box>
    </Stack>
  )
}
