import { useNavigate } from 'react-router-dom'
import { Box, Button, Stack, Typography } from '@mui/material'
import KeyRounded from '@mui/icons-material/KeyRounded'
import { ROUTES } from '../../../config/routes'

/**
 * passkey-auth US1 (scenario 9), FR-063 — a verification or reset link mailed before cutover still
 * lands somewhere: it explains the change and leads to sign-in, never a blank screen.
 */
export function LegacyLinkNotice() {
  const navigate = useNavigate()

  return (
    <Stack spacing={2} sx={{ py: 2, alignItems: 'center', textAlign: 'center' }}>
      <Box sx={{ color: 'text.secondary', display: 'flex' }}>
        <KeyRounded sx={{ fontSize: 48 }} aria-hidden />
      </Box>
      <Typography sx={{ maxWidth: 360 }}>
        Ya no usamos contraseñas. Entra con tu llave de acceso o con un código por correo.
      </Typography>
      <Button variant="contained" onClick={() => navigate(ROUTES.LOGIN, { replace: true })}>
        Ir a iniciar sesión
      </Button>
    </Stack>
  )
}
