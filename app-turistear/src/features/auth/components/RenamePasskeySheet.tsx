import { useEffect } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Alert, TextField } from '@mui/material'
import { FormSheet } from '../../../components'
import { passkeyNameSchema, type PasskeyNameFormData } from '../schemas'
import { useRenamePasskey } from '../hooks/usePasskeys'
import type { PasskeyRecord } from '../types'
import { passkeyLabel } from './passkeyLabel'

interface RenamePasskeySheetProps {
  passkey: PasskeyRecord | null
  open: boolean
  onClose: () => void
}

/** Rename one llave de acceso (passkey-auth US5, FR-004) — the change applies to that one only. */
export function RenamePasskeySheet({ passkey, open, onClose }: RenamePasskeySheetProps) {
  const rename = useRenamePasskey()
  const { reset: resetMutation } = rename

  const { control, handleSubmit, reset } = useForm<PasskeyNameFormData>({
    resolver: zodResolver(passkeyNameSchema),
    defaultValues: { name: '' },
  })

  // Prefill whenever another llave is picked, and forget the last attempt's failure.
  useEffect(() => {
    if (passkey) {
      reset({ name: passkeyLabel(passkey) })
      resetMutation()
    }
  }, [passkey, reset, resetMutation])

  const onSubmit = handleSubmit(({ name }) => {
    if (!passkey) return
    rename.mutate({ id: passkey.id, name }, { onSuccess: onClose })
  })

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Cambiar nombre"
      submitLabel="Guardar"
      onSubmit={onSubmit}
      busy={rename.isPending}
      error={
        rename.isError ? (
          <Alert severity="error">No se pudo cambiar el nombre. Inténtalo de nuevo.</Alert>
        ) : undefined
      }
    >
      <Controller
        name="name"
        control={control}
        render={({ field, fieldState }) => (
          <TextField
            {...field}
            inputRef={field.ref}
            label="Nombre de la llave de acceso"
            fullWidth
            disabled={rename.isPending}
            error={!!fieldState.error}
            helperText={fieldState.error?.message ?? 'Por ejemplo: «iPhone de Luis» o «Llave del mostrador».'}
          />
        )}
      />
    </FormSheet>
  )
}
