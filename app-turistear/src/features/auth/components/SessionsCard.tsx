import { useState } from 'react'
import { Button, Typography } from '@mui/material'
import LogoutRounded from '@mui/icons-material/LogoutRounded'
import { SectionCard } from '../../../components'
import { SignOutEverywhereSheet } from './SignOutEverywhereSheet'

/** passkey-auth US5 (scenario 4) — where a lost or shared phone's session is cut off. */
export function SessionsCard() {
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <SectionCard title="Sesiones">
        <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
          Si entraste en un teléfono prestado o perdiste uno, cierra la sesión en todos tus
          dispositivos, incluido este.
        </Typography>
        <Button
          fullWidth
          variant="outlined"
          color="error"
          startIcon={<LogoutRounded />}
          onClick={() => setConfirming(true)}
        >
          Cerrar sesión en todos los dispositivos
        </Button>
      </SectionCard>
      <SignOutEverywhereSheet open={confirming} onClose={() => setConfirming(false)} />
    </>
  )
}
