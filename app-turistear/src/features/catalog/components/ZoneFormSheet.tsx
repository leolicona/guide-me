import { useState } from 'react'
import { Alert, Stack, TextField } from '@mui/material'
import { FormSheet } from '../../../components'
import { ServiceError } from '../../../services/authService'
import { useZoneMutations } from '../hooks/useZones'
import type { ServiceZone } from '../types'

interface ZoneFormSheetProps {
  serviceId: string
  /** null = add a new zone; a zone = edit it. */
  zone: ServiceZone | null
  open: boolean
  onClose: () => void
}

// US-A64 — add one zone to a zoned service, or rename/resize an existing one. Shrinking below a
// future departure's sold seats is refused by the API (409) and surfaced inline.
export function ZoneFormSheet({ serviceId, zone, open, onClose }: ZoneFormSheetProps) {
  const { create, update } = useZoneMutations(serviceId)
  const [name, setName] = useState('')
  const [capacity, setCapacity] = useState('')
  const [error, setError] = useState('')

  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName(zone?.name ?? '')
      setCapacity(zone ? String(zone.capacity) : '')
      setError('')
    }
  }

  const cap = Number(capacity)
  const valid = name.trim().length > 0 && Number.isInteger(cap) && cap >= 1
  const busy = create.isPending || update.isPending

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    const data = { name: name.trim(), capacity: cap }
    const onError = (err: unknown) => {
      const e2 = err as ServiceError
      setError(
        e2?.status === 409 && /below|sold|vend/i.test(e2.message)
          ? 'No puedes reducir por debajo de los asientos ya vendidos en una salida futura.'
          : e2?.status === 409
            ? 'Ya existe una zona con ese nombre.'
            : 'No se pudo guardar la zona.',
      )
    }
    if (zone) {
      update.mutate({ zoneId: zone.id, data }, { onSuccess: onClose, onError })
    } else {
      create.mutate(data, { onSuccess: onClose, onError })
    }
  }

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title={zone ? 'Editar zona' : 'Agregar zona'}
      submitLabel={zone ? 'Guardar' : 'Agregar'}
      busy={busy}
      disabled={!valid}
      onSubmit={submit}
      error={error ? <Alert severity="error">{error}</Alert> : undefined}
    >
      <Stack spacing={2}>
        <TextField
          label="Nombre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          fullWidth
          autoFocus
          slotProps={{ htmlInput: { maxLength: 40 } }}
        />
        <TextField
          label="Asientos"
          type="number"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          fullWidth
          slotProps={{ htmlInput: { min: 1, step: 1 } }}
        />
      </Stack>
    </FormSheet>
  )
}
