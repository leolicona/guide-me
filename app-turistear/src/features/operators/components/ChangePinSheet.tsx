import { useState } from 'react'
import { Alert, Stack, TextField } from '@mui/material'
import { FormSheet } from '../../../components'
import { changeOperatorPin } from '../../../services/operatorsService'
import { ServiceError } from '../../../services/authService'

interface ChangePinSheetProps {
  open: boolean
  onClose: () => void
}

const isPin = (v: string) => /^\d{4}$/.test(v)

// US-OP02 — an operator changes their own 4-digit PIN from within an active shift.
export function ChangePinSheet({ open, onClose }: ChangePinSheetProps) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const canSubmit = isPin(current) && isPin(next) && next === confirm

  const close = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
    setError(null)
    setDone(false)
    onClose()
  }

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await changeOperatorPin(current, next, confirm)
      setDone(true)
      setTimeout(close, 900)
    } catch (err) {
      const s = err as ServiceError
      setError(s.status === 401 ? 'El PIN actual es incorrecto.' : 'No se pudo cambiar el PIN.')
      setBusy(false)
    }
  }

  const pinField = (label: string, value: string, set: (v: string) => void) => (
    <TextField
      label={label}
      value={value}
      onChange={(e) => set(e.target.value.replace(/\D/g, '').slice(0, 4))}
      type="password"
      inputMode="numeric"
      fullWidth
      slotProps={{ htmlInput: { maxLength: 4, style: { letterSpacing: '0.5em' } } }}
    />
  )

  return (
    <FormSheet
      open={open}
      onClose={close}
      title="Cambiar PIN"
      submitLabel="Guardar"
      onSubmit={submit}
      busy={busy}
      disabled={!canSubmit}
      error={
        done ? (
          <Alert severity="success">PIN actualizado.</Alert>
        ) : error ? (
          <Alert severity="error">{error}</Alert>
        ) : undefined
      }
    >
      <Stack spacing={2.5} sx={{ pt: 1 }}>
        {pinField('PIN actual', current, setCurrent)}
        {pinField('Nuevo PIN', next, setNext)}
        {pinField('Confirmar nuevo PIN', confirm, setConfirm)}
      </Stack>
    </FormSheet>
  )
}
