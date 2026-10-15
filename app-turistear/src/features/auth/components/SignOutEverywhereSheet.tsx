import { Alert } from '@mui/material'
import { ConfirmSheet } from '../../../components'
import { useSignOutEverywhere } from '../hooks/useSignOutEverywhere'

interface SignOutEverywhereSheetProps {
  open: boolean
  onClose: () => void
}

/**
 * "Cerrar sesión en todos los dispositivos" (passkey-auth US5, scenario 4, FR-024): every session
 * of the account ends, this one included, so the screen goes back to sign-in.
 */
export function SignOutEverywhereSheet({ open, onClose }: SignOutEverywhereSheetProps) {
  const signOutEverywhere = useSignOutEverywhere()

  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title="¿Cerrar sesión en todos los dispositivos?"
      description="Se cerrará tu sesión aquí y en cualquier otro teléfono o computadora. Para volver a entrar usa tu llave de acceso o un código por correo."
      confirmLabel="Cerrar sesión en todos los dispositivos"
      busy={signOutEverywhere.isPending}
      onConfirm={() => signOutEverywhere.mutate()}
      error={
        signOutEverywhere.isError ? (
          <Alert severity="error">
            No se pudo cerrar la sesión en tus dispositivos. Revisa tu conexión e inténtalo de nuevo.
          </Alert>
        ) : undefined
      }
    />
  )
}
