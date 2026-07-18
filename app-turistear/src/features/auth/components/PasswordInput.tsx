import { useState } from 'react'
import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'
import Visibility from '@mui/icons-material/Visibility'
import VisibilityOff from '@mui/icons-material/VisibilityOff'

interface PasswordInputProps<T extends FieldValues> {
  name: FieldPath<T>
  control: Control<T>
  label: string
  helperText?: string
  disabled?: boolean
}

export function PasswordInput<T extends FieldValues>({
  name,
  control,
  label,
  helperText,
  disabled,
}: PasswordInputProps<T>) {
  const [show, setShow] = useState(false)

  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <TextField
          {...field}
          label={label}
          type={show ? 'text' : 'password'}
          fullWidth
          disabled={disabled}
          error={!!fieldState.error}
          helperText={fieldState.error?.message ?? helperText}
          slotProps={{
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    onClick={() => setShow((prev) => !prev)}
                    edge="end"
                    size="small"
                  >
                    {show ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
        />
      )}
    />
  )
}
