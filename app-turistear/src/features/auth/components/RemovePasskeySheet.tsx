import { useEffect } from 'react'
import { Alert } from '@mui/material'
import { ConfirmSheet } from '../../../components'
import { useRemovePasskey } from '../hooks/usePasskeys'
import type { PasskeyRecord } from '../types'
import { passkeyLabel } from './passkeyLabel'

interface RemovePasskeySheetProps {
  passkey: PasskeyRecord | null
  open: boolean
  onClose: () => void
}

/**
 * Remove one llave de acceso (passkey-auth US5, scenarios 2–3) — how a lost phone is cut off. The
 * last one may go too: the email code still signs in.
 */
export function RemovePasskeySheet({ passkey, open, onClose }: RemovePasskeySheetProps) {
  const remove = useRemovePasskey()
  const { reset } = remove

  useEffect(() => {
    if (passkey) reset()
  }, [passkey, reset])

  const name = passkey ? passkeyLabel(passkey) : ''

  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title="¿Eliminar esta llave de acceso?"
      description={`«${name}» ya no podrá entrar a tu cuenta. Siempre puedes entrar con un código por correo.`}
      confirmLabel="Eliminar llave de acceso"
      busy={remove.isPending}
      onConfirm={() => {
        if (passkey) remove.mutate(passkey.id, { onSuccess: onClose })
      }}
      error={
        remove.isError ? (
          <Alert severity="error">No se pudo eliminar la llave de acceso. Inténtalo de nuevo.</Alert>
        ) : undefined
      }
    />
  )
}
